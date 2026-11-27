/*
  ============================================================================
   ESP32 MESTRA - RECEPCAO CAN (TWAI) + SAIDA PELA USB (SERIAL)
   ESP32 DevKit V1 / Arduino-ESP32 3.3.x

   Escravas:
     Temperatura: ID 0x100 (10 MAX6675 + DHT22)
     Aquecimento: ID 0x200
     Temp. internas: ID 0x300 (10 termopares + DHT22, mesmo formato da 0x100)
     Balanca:     ID 0x500 (massa do bio-oleo)
     Queimagas:   ID 0x600

   CAN: 500 kbps, CAN padrao (11 bits)
   Saida: USB / Serial a 115200 baud (sem Wi-Fi)

   MODO DE SAIDA (escolha em SAIDA_JSON, logo abaixo):
     0 = texto legivel no Monitor Serial (cada mensagem CAN e impressa)
     1 = uma linha JSON por segundo com todos os dados, para um programa
         ou pagina no notebook ler pela porta serial

   PROTOCOLO TEMPERATURA (ID 0x100 e ID 0x300 - mesmo formato):
     DLC 7 | byte0 = tipo (0x01..0x04) | 3 x int16 little-endian
     Escala: valor * 10  (0,1 C de resolucao, faixa -3276,7 a +3276,7 C)
     INT16_MIN (0x8000) = sem leitura
     >>> A escrava de temperatura precisa usar a MESMA escala (x10) <<<

   PROTOCOLO BALANCA (ID 0x500):
     DLC 4 | bytes 0..3 = float IEEE-754 (little-endian), massa em kg

   LINHAS LIDAS PELO SITE (pyrolise-dashboard), alem das medidas:
     "estado=N txErr=A rxErr=B"  estado do barramento, a cada 1 s
     "TX: ESP_OK"                resultado do quadro de teste (se ENVIAR_TESTE)
     "RX id=0x123 dado=42"       qualquer ID fora de 0x100/0x200/0x300/0x500/0x600
   No modo JSON o site le a linha JSON (o estado do barramento vai junto).
  ============================================================================
*/

#include <Arduino.h>
#include <math.h>
#include <stdint.h>
#include <string.h>
#include "driver/twai.h"

// ============================ MODO DE SAIDA =================================
#define SAIDA_JSON 0   // 0 = texto legivel | 1 = linha JSON a cada segundo

const uint32_t INTERVALO_JSON_MS = 1000;

#if SAIDA_JSON
  #define LOGF(...)  do {} while (0)
  #define LOGLN(x)   do {} while (0)
#else
  #define LOGF(...)  Serial.printf(__VA_ARGS__)
  #define LOGLN(x)   Serial.println(x)
#endif

// ============================ CONFIGURACAO CAN ==============================
#define CAN_TX_PIN          5
#define CAN_RX_PIN          4

#define CAN_ID_TEMPERATURA  0x100
#define CAN_ID_AQUECIMENTO  0x200
#define CAN_ID_TEMP_INTERNA 0x300
#define CAN_ID_MASSA        0x500
#define CAN_ID_QUEIMAGAS    0x600

#define MSG_MEDIDAS         0x01
#define MSG_ENERGIA         0x02

#define MSG_TEMPERATURAS_1  0x01
#define MSG_TEMPERATURAS_2  0x02
#define MSG_TEMPERATURAS_3  0x03
#define MSG_TEMPERATURAS_4  0x04

#define MSG_QUEIMAGAS_MEDIDAS 0x01
#define MSG_QUEIMAGAS_CALOR   0x02

// Escala das temperaturas da escrava 0x100 (deve ser igual na escrava)
#define ESCALA_TEMPERATURA  10.0f

#define CAN_RX_QUEUE_LEN    32

const uint32_t TIMEOUT_CAN_MS            = 3000;
const uint32_t INTERVALO_CHECK_CAN_MS    = 500;
const uint32_t INTERVALO_REINIT_CAN_MS   = 5000;
const uint32_t INTERVALO_STATUS_MS       = 1000;  // linha "estado=..." para o site

// ----------------------- Teste do barramento --------------------------------
// Quadro de teste ID 0x123 com contador. Use true so para testar o barramento:
// com a mestra sozinha no fio (sem ACK) ele faz os contadores de erro subirem.
#define CAN_ID_TESTE        0x123
const bool     ENVIAR_TESTE     = false;
const uint32_t INTERVALO_TX_MS  = 500;

// =============================== DADOS ======================================

// ----------------------- Temperatura (ID 0x100) ----------------------------
float temperaturas[11] = {
  NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN
};

uint32_t ultimaMensagemTemperatura = 0;
bool desconexaoTemperaturaInformada = false;

// ----------------------- Temperaturas internas (ID 0x300) ------------------
float temperaturasInternas[11] = {
  NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN
};

uint32_t ultimaMensagemTempInterna = 0;
bool desconexaoTempInternaInformada = false;

// ----------------------- Aquecimento (ID 0x200) ----------------------------
float temperaturaReator = NAN;
float tensao = NAN;
float corrente = NAN;
float energiaConsumida = NAN;

uint32_t ultimaMensagemAquecimento = 0;
bool desconexaoInformada = false;

// ----------------------- Balanca (ID 0x500) --------------------------------
float massaKg = NAN;

uint32_t ultimaMensagemMassa = 0;
bool desconexaoMassaInformada = false;

// ----------------------- Queimagas (ID 0x600) ------------------------------
float temperaturaAgua = NAN;
int8_t presencaGas = -1;
int8_t presencaChama = -1;

uint32_t calorJoules = 0;
bool calorValido = false;

uint32_t ultimaMensagemQueimagas = 0;
bool desconexaoQueimagasInformada = false;

// ----------------------- Status CAN -----------------------------------------
bool canOk = false;
uint32_t ultimaVerificacaoCAN = 0;
uint32_t ultimaTentativaInitCAN = 0;
uint32_t ultimoEnvioJson = 0;

// ultimo estado lido do driver TWAI (-1 = ainda nao lido)
int estadoBarramento = -1;
uint32_t txErrBarramento = 0;
uint32_t rxErrBarramento = 0;

// ============================ JSON (SAIDA_JSON = 1) =========================
String floatParaJson(float valor, int casas) {
  if (isnan(valor) || isinf(valor)) {
    return "null";
  }
  return String(valor, casas);
}

bool estaOnline(uint32_t ultimaMensagem, uint32_t agora) {
  return (ultimaMensagem != 0) && (agora - ultimaMensagem <= TIMEOUT_CAN_MS);
}

String gerarJsonTelemetria() {
  String json;
  json.reserve(1200);
  json = "{";

  uint32_t agora = millis();

  json += "\"can_ok\":";
  json += (canOk ? "true" : "false");
  json += ",";

  // Estado do barramento (0 parado, 1 ok, 2 bus-off, 3 recuperando)
  json += "\"barramento\":{\"estado\":";
  json += (estadoBarramento < 0 ? String("null") : String(estadoBarramento));
  json += ",\"tx_err\":";
  json += String(txErrBarramento);
  json += ",\"rx_err\":";
  json += String(rxErrBarramento);
  json += "},";

  // Temperatura (ID 0x100)
  json += "\"temperatura\":{\"online\":";
  json += (estaOnline(ultimaMensagemTemperatura, agora) ? "true" : "false");
  json += ",\"termopares\":[";
  for (int i = 0; i < 10; i++) {
    json += floatParaJson(temperaturas[i], 1);
    if (i < 9) json += ",";
  }
  json += "],\"dht22\":";
  json += floatParaJson(temperaturas[10], 1);
  json += "},";

  // Temperaturas internas (ID 0x300)
  json += "\"temperatura_interna\":{\"online\":";
  json += (estaOnline(ultimaMensagemTempInterna, agora) ? "true" : "false");
  json += ",\"termopares\":[";
  for (int i = 0; i < 10; i++) {
    json += floatParaJson(temperaturasInternas[i], 1);
    if (i < 9) json += ",";
  }
  json += "],\"dht22\":";
  json += floatParaJson(temperaturasInternas[10], 1);
  json += "},";

  // Aquecimento (ID 0x200)
  json += "\"aquecimento\":{\"online\":";
  json += (estaOnline(ultimaMensagemAquecimento, agora) ? "true" : "false");
  json += ",\"temperatura_reator\":";
  json += floatParaJson(temperaturaReator, 2);
  json += ",\"tensao\":";
  json += floatParaJson(tensao, 1);
  json += ",\"corrente\":";
  json += floatParaJson(corrente, 3);
  json += ",\"energia_kwh\":";
  json += floatParaJson(energiaConsumida, 3);
  json += "},";

  // Balanca (ID 0x500)
  json += "\"balanca\":{\"online\":";
  json += (estaOnline(ultimaMensagemMassa, agora) ? "true" : "false");
  json += ",\"massa_kg\":";
  json += floatParaJson(massaKg, 3);
  json += "},";

  // Queimagas (ID 0x600)
  json += "\"queimagas\":{\"online\":";
  json += (estaOnline(ultimaMensagemQueimagas, agora) ? "true" : "false");
  json += ",\"temperatura_agua\":";
  json += floatParaJson(temperaturaAgua, 2);
  json += ",\"presenca_gas\":";
  json += String((int)presencaGas);
  json += ",\"presenca_chama\":";
  json += String((int)presencaChama);
  json += ",\"calor_joules\":";
  json += (calorValido ? String(calorJoules) : String("null"));
  json += "}";

  json += "}";
  return json;
}

void enviarJsonSerial() {
#if SAIDA_JSON
  uint32_t agora = millis();
  if (agora - ultimoEnvioJson >= INTERVALO_JSON_MS) {
    ultimoEnvioJson = agora;
    Serial.println(gerarJsonTelemetria());
  }
#endif
}

// ============================ CAN ===========================================
bool iniciarCAN() {
  twai_general_config_t configGeral =
    TWAI_GENERAL_CONFIG_DEFAULT(
      (gpio_num_t)CAN_TX_PIN,
      (gpio_num_t)CAN_RX_PIN,
      TWAI_MODE_NORMAL
    );
  configGeral.rx_queue_len = CAN_RX_QUEUE_LEN;

  twai_timing_config_t configTempo = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t configFiltro = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  esp_err_t resultado = twai_driver_install(&configGeral, &configTempo, &configFiltro);
  if (resultado != ESP_OK) {
    LOGF("[CAN] Erro ao instalar driver: %d (%s)\n",
         (int)resultado, esp_err_to_name(resultado));
    return false;
  }

  resultado = twai_start();
  if (resultado != ESP_OK) {
    LOGF("[CAN] Erro ao iniciar driver: %d (%s)\n",
         (int)resultado, esp_err_to_name(resultado));
    twai_driver_uninstall();
    return false;
  }

  LOGLN("[CAN] Interface iniciada em 500 kbps.");
  LOGLN("[CAN] Aguardando:");
  LOGLN("  ID 0x100 - Temperatura");
  LOGLN("  ID 0x200 - Aquecimento");
  LOGLN("  ID 0x300 - Temperaturas internas");
  LOGLN("  ID 0x500 - Balanca");
  LOGLN("  ID 0x600 - Queimagas");
  return true;
}

// Recupera de bus-off e reinicia o controlador quando necessario
void verificarBarramentoCAN() {
  uint32_t agora = millis();

  if (!canOk) {
    if (agora - ultimaTentativaInitCAN >= INTERVALO_REINIT_CAN_MS) {
      ultimaTentativaInitCAN = agora;
      LOGLN("[CAN] Tentando iniciar a interface novamente...");
      canOk = iniciarCAN();
    }
    return;
  }

  if (agora - ultimaVerificacaoCAN < INTERVALO_CHECK_CAN_MS) return;
  ultimaVerificacaoCAN = agora;

  twai_status_info_t status;
  if (twai_get_status_info(&status) != ESP_OK) return;

  estadoBarramento = (int)status.state;
  txErrBarramento = status.tx_error_counter;
  rxErrBarramento = status.rx_error_counter;

  static uint32_t ultimoStatus = 0;
  if (agora - ultimoStatus >= INTERVALO_STATUS_MS) {
    ultimoStatus = agora;
    LOGF("estado=%d txErr=%lu rxErr=%lu\n", estadoBarramento,
         (unsigned long)txErrBarramento, (unsigned long)rxErrBarramento);
  }

  if (status.state == TWAI_STATE_BUS_OFF) {
    LOGLN("[CAN] BUS-OFF detectado. Iniciando recuperacao...");
    twai_initiate_recovery();
  }
  else if (status.state == TWAI_STATE_STOPPED) {
    if (twai_start() == ESP_OK) {
      LOGLN("[CAN] Barramento recuperado e interface reiniciada.");
    }
  }

  static uint32_t ultimoOverrun = 0;
  static uint32_t ultimoMissed = 0;
  if (status.rx_overrun_count != ultimoOverrun || status.rx_missed_count != ultimoMissed) {
    LOGF("[CAN] AVISO: mensagens perdidas (overrun=%lu, missed=%lu)\n",
         (unsigned long)status.rx_overrun_count,
         (unsigned long)status.rx_missed_count);
    ultimoOverrun = status.rx_overrun_count;
    ultimoMissed = status.rx_missed_count;
  }
}

// ========================== RECEPCAO TEMPERATURA ============================
void imprimirTemperatura(const char* nome, float valor) {
  if (!isnan(valor)) LOGF("%s: %.1f C\n", nome, valor);
  else LOGF("%s: SEM LEITURA\n", nome);
}

// Usada pelas duas placas de termopares (0x100 e 0x300), que tem o mesmo
// formato de quadro. Cada uma grava no seu proprio vetor.
// O site separa as duas pelo titulo do bloco ("TEMPERATURAS" ou "TEMP. INTERNAS").
void receberQuadroTemperaturas(const twai_message_t &mensagem,
                               float destino[11],
                               uint32_t &ultimaMensagem,
                               bool &desconexaoInformadaFlag,
                               const char* titulo) {
  if (mensagem.extd || mensagem.rtr || mensagem.data_length_code != 7) return;

  uint8_t tipoMensagem = mensagem.data[0];
  if (tipoMensagem < MSG_TEMPERATURAS_1 || tipoMensagem > MSG_TEMPERATURAS_4) return;

  float valores[3];
  for (int i = 0; i < 3; i++) {
    uint16_t bits =
      (uint16_t)mensagem.data[1 + i * 2] |
      ((uint16_t)mensagem.data[2 + i * 2] << 8);
    int16_t raw = (int16_t)bits;
    valores[i] = (raw == INT16_MIN) ? NAN : raw / ESCALA_TEMPERATURA;
  }

  // Quadro 1 -> T1..T3 | Quadro 2 -> T4..T6 | Quadro 3 -> T7..T9
  // Quadro 4 -> T10 e DHT22 (terceiro valor nao usado)
  int base = (tipoMensagem - 1) * 3;
  int quantidade = (tipoMensagem == MSG_TEMPERATURAS_4) ? 2 : 3;

  for (int i = 0; i < quantidade; i++) {
    destino[base + i] = valores[i];
  }

  LOGF("\n========== %s / QUADRO %u ==========\n", titulo, tipoMensagem);
  for (int i = 0; i < quantidade; i++) {
    int indice = base + i;
    if (indice == 10) {
      imprimirTemperatura("DHT22", destino[indice]);
    } else {
      char nome[6];
      snprintf(nome, sizeof(nome), "T%d", indice + 1);
      imprimirTemperatura(nome, destino[indice]);
    }
  }
  LOGLN("==============================================");

  ultimaMensagem = millis();
  desconexaoInformadaFlag = false;
}

void receberTemperatura(const twai_message_t &mensagem) {
  receberQuadroTemperaturas(mensagem, temperaturas,
                            ultimaMensagemTemperatura,
                            desconexaoTemperaturaInformada,
                            "TEMPERATURAS");
}

void receberTemperaturaInterna(const twai_message_t &mensagem) {
  receberQuadroTemperaturas(mensagem, temperaturasInternas,
                            ultimaMensagemTempInterna,
                            desconexaoTempInternaInformada,
                            "TEMP. INTERNAS");
}

// ============================ RECEPCAO AQUECIMENTO ==========================
void receberAquecimento(const twai_message_t &mensagem) {
  if (mensagem.extd || mensagem.rtr || mensagem.data_length_code == 0) return;

  uint8_t tipoMensagem = mensagem.data[0];
  uint32_t agora = millis();

  if (tipoMensagem == MSG_MEDIDAS && mensagem.data_length_code == 7) {
    uint16_t temperaturaBits =
      (uint16_t)mensagem.data[1] |
      ((uint16_t)mensagem.data[2] << 8);
    int16_t temperaturaRaw = (int16_t)temperaturaBits;

    uint16_t tensaoRaw =
      (uint16_t)mensagem.data[3] |
      ((uint16_t)mensagem.data[4] << 8);

    uint16_t correnteRaw =
      (uint16_t)mensagem.data[5] |
      ((uint16_t)mensagem.data[6] << 8);

    temperaturaReator = (temperaturaRaw == INT16_MIN) ? NAN : temperaturaRaw / 100.0f;
    tensao   = (tensaoRaw   == UINT16_MAX) ? NAN : tensaoRaw / 10.0f;
    corrente = (correnteRaw == UINT16_MAX) ? NAN : correnteRaw / 1000.0f;

    ultimaMensagemAquecimento = agora;
    desconexaoInformada = false;

    LOGLN("\n========== AQUECIMENTO / MEDIDAS ==========");
    if (!isnan(temperaturaReator)) LOGF("Temperatura do reator: %.2f C\n", temperaturaReator);
    else LOGLN("Temperatura do reator: SEM LEITURA");

    if (!isnan(tensao)) LOGF("Tensao: %.1f V\n", tensao);
    else LOGLN("Tensao: SEM LEITURA");

    if (!isnan(corrente)) LOGF("Corrente: %.3f A\n", corrente);
    else LOGLN("Corrente: SEM LEITURA");
    LOGLN("============================================");
  }
  else if (tipoMensagem == MSG_ENERGIA && mensagem.data_length_code == 5) {
    uint32_t energiaRaw =
      (uint32_t)mensagem.data[1] |
      ((uint32_t)mensagem.data[2] << 8) |
      ((uint32_t)mensagem.data[3] << 16) |
      ((uint32_t)mensagem.data[4] << 24);

    energiaConsumida = (energiaRaw == UINT32_MAX) ? NAN : energiaRaw / 1000.0f;

    ultimaMensagemAquecimento = agora;
    desconexaoInformada = false;

    if (!isnan(energiaConsumida)) LOGF("Energia acumulada: %.3f kWh\n", energiaConsumida);
    else LOGLN("Energia acumulada: SEM LEITURA");
  }
}

// ========================== RECEPCAO BALANCA ===============================
void receberMassa(const twai_message_t &mensagem) {
  if (mensagem.extd || mensagem.rtr || mensagem.data_length_code != 4) return;

  float valor;
  memcpy(&valor, mensagem.data, sizeof(float));

  massaKg = (isnan(valor) || isinf(valor)) ? NAN : valor;

  ultimaMensagemMassa = millis();
  desconexaoMassaInformada = false;

  if (!isnan(massaKg)) LOGF("Massa (bio-oleo): %.3f kg\n", massaKg);
  else LOGLN("Massa (bio-oleo): SEM LEITURA");
}

// ======================== RECEPCAO QUEIMAGAS ===============================
// ATENCAO: aqui os dados sao lidos em BIG-ENDIAN (byte mais significativo
// primeiro), diferente das outras escravas. Confirme no codigo da escrava.
void receberQueimagas(const twai_message_t &mensagem) {
  if (mensagem.extd || mensagem.rtr || mensagem.data_length_code != 5) return;

  uint8_t tipoMensagem = mensagem.data[0];
  uint32_t agora = millis();

  if (tipoMensagem == MSG_QUEIMAGAS_MEDIDAS) {
    uint16_t temperaturaBits =
      ((uint16_t)mensagem.data[1] << 8) |
      (uint16_t)mensagem.data[2];
    int16_t temperaturaRaw = (int16_t)temperaturaBits;

    temperaturaAgua = (temperaturaRaw == INT16_MIN) ? NAN : temperaturaRaw / 100.0f;
    presencaGas   = (mensagem.data[3] <= 1) ? (int8_t)mensagem.data[3] : -1;
    presencaChama = (mensagem.data[4] <= 1) ? (int8_t)mensagem.data[4] : -1;

    ultimaMensagemQueimagas = agora;
    desconexaoQueimagasInformada = false;

    LOGLN("\n========== QUEIMAGAS / MEDIDAS ==========");
    if (!isnan(temperaturaAgua)) LOGF("Temperatura da agua: %.2f C\n", temperaturaAgua);
    else LOGLN("Temperatura da agua: SEM LEITURA");

    if (presencaGas == 1) LOGLN("Presenca de gas: Sim");
    else if (presencaGas == 0) LOGLN("Presenca de gas: Nao");
    else LOGLN("Presenca de gas: DADO INVALIDO");

    if (presencaChama == 1) LOGLN("Presenca de chama: Sim");
    else if (presencaChama == 0) LOGLN("Presenca de chama: Nao");
    else LOGLN("Presenca de chama: DADO INVALIDO");
    LOGLN("==========================================");
  }
  else if (tipoMensagem == MSG_QUEIMAGAS_CALOR) {
    uint32_t calorRaw =
      ((uint32_t)mensagem.data[1] << 24) |
      ((uint32_t)mensagem.data[2] << 16) |
      ((uint32_t)mensagem.data[3] << 8) |
      (uint32_t)mensagem.data[4];

    calorValido = (calorRaw != UINT32_MAX);
    if (calorValido) {
      calorJoules = calorRaw;
    }

    ultimaMensagemQueimagas = agora;
    desconexaoQueimagasInformada = false;

    if (calorValido) LOGF("Calor: %lu J\n", (unsigned long)calorJoules);
    else LOGLN("Calor: SEM LEITURA");
  }
}

// ======================== PROCESSAMENTO CAN =================================
void processarMensagensCAN() {
  if (!canOk) return;

  twai_message_t mensagem;

  while (twai_receive(&mensagem, 0) == ESP_OK) {
    switch (mensagem.identifier) {
      case CAN_ID_TEMPERATURA: receberTemperatura(mensagem); break;
      case CAN_ID_AQUECIMENTO: receberAquecimento(mensagem); break;
      case CAN_ID_TEMP_INTERNA: receberTemperaturaInterna(mensagem); break;
      case CAN_ID_MASSA:       receberMassa(mensagem);       break;
      case CAN_ID_QUEIMAGAS:   receberQueimagas(mensagem);   break;
      default:
        // Qualquer outro ID (ex.: 0x123 de outra placa de teste)
        LOGF("RX id=0x%X dado=%d\n", (unsigned)mensagem.identifier,
             mensagem.data_length_code > 0 ? mensagem.data[0] : 0);
        break;
    }
  }
}

// Quadro de teste do barramento (so quando ENVIAR_TESTE = true)
void enviarTeste() {
  if (!ENVIAR_TESTE || !canOk) return;

  static uint8_t contador = 0;
  static uint32_t ultimoEnvio = 0;
  uint32_t agora = millis();
  if (agora - ultimoEnvio < INTERVALO_TX_MS) return;
  ultimoEnvio = agora;

  twai_message_t m = {};
  m.identifier = CAN_ID_TESTE;
  m.data_length_code = 1;
  m.data[0] = contador++;

  // sem espera: a recepcao das escravas nao para enquanto o quadro sai
  esp_err_t resultado = twai_transmit(&m, 0);
  LOGF("TX: %s\n", esp_err_to_name(resultado));
  (void)resultado;  // no modo JSON o LOGF nao imprime
}

// ============================== MONITOR =====================================
void verificarTimeout(uint32_t ultimaMensagem, bool &informado,
                      const char* aviso, uint32_t agora) {
  if (ultimaMensagem != 0 &&
      agora - ultimaMensagem > TIMEOUT_CAN_MS &&
      !informado) {
    LOGLN(aviso);
    informado = true;
  }
}

void monitorarConexaoCAN() {
  if (!canOk) return;

  uint32_t agora = millis();

  verificarTimeout(ultimaMensagemTemperatura, desconexaoTemperaturaInformada,
    "[CAN] ATENCAO: sem comunicacao com a escrava Temperatura (ID 0x100).", agora);
  verificarTimeout(ultimaMensagemAquecimento, desconexaoInformada,
    "[CAN] ATENCAO: sem comunicacao com a escrava de aquecimento (ID 0x200).", agora);
  verificarTimeout(ultimaMensagemTempInterna, desconexaoTempInternaInformada,
    "[CAN] ATENCAO: sem comunicacao com a escrava Temp. internas (ID 0x300).", agora);
  verificarTimeout(ultimaMensagemMassa, desconexaoMassaInformada,
    "[CAN] ATENCAO: sem comunicacao com a escrava da Balanca (ID 0x500).", agora);
  verificarTimeout(ultimaMensagemQueimagas, desconexaoQueimagasInformada,
    "[CAN] ATENCAO: sem comunicacao com a escrava de Queimagas (ID 0x600).", agora);
}

// ================================= SETUP ==================================
void setup() {
  Serial.begin(115200);
  delay(500);

  LOGLN("");
  LOGLN("============================================");
  LOGLN("       ESP32 MESTRA - SUPERVISOR CAN");
  LOGLN("============================================");

  canOk = iniciarCAN();
  ultimaTentativaInitCAN = millis();
  if (!canOk) {
    LOGLN("[CAN] Falha na inicializacao. Verifique pinos e transceiver.");
    LOGLN("[CAN] Nova tentativa a cada 5 s.");
  }
}

// ================================= LOOP ===================================
void loop() {
  processarMensagensCAN();
  enviarTeste();
  verificarBarramentoCAN();
  monitorarConexaoCAN();
  enviarJsonSerial();
}
