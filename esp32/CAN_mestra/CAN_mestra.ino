/*
  ============================================================================
   ESP32 MESTRA - RECEPCAO CAN (TWAI) + TESTE DE BARRAMENTO
   ESP32 DevKit V1 / Arduino-ESP32 3.3.x

   Escravas:
     Temperatura: ID 0x100 (10 MAX6675 + DHT22)
     Aquecimento: ID 0x200
     Queimagas:   ID 0x600

   CAN: 500 kbps, CAN padrao (11 bits)

   Ligacao com o transceiver CAN:
     GPIO21 (TX) -> TX / CTX / D do transceiver
     GPIO22 (RX) -> RX / CRX / R do transceiver
   Nao use GPIO1 e GPIO3: sao o TX/RX do USB (Serial).

   Baseado no teste TWAI (2026-11-26):
     - envia um quadro de teste ID 0x123 com contador a cada 500 ms
     - imprime "TX: ...", "RX id=0x... dado=..." e "estado=... txErr=... rxErr=..."
     - recupera o barramento sozinho quando entra em BUS-OFF
   O site le essas linhas pelo USB junto com as das escravas.
  ============================================================================
*/

#include <Arduino.h>
#include <math.h>
#include <stdint.h>
#include "driver/twai.h"

// ============================ CONFIGURACAO CAN ==============================
#define CAN_TX_PIN          21   // antes: 1 (pino do USB, apagava o Serial)
#define CAN_RX_PIN          22   // antes: 3 (pino do USB, apagava o Serial)

#define CAN_ID_TEMPERATURA  0x100
#define CAN_ID_AQUECIMENTO  0x200
#define CAN_ID_QUEIMAGAS    0x600

#define MSG_MEDIDAS         0x01
#define MSG_ENERGIA         0x02

#define MSG_TEMPERATURAS_1  0x01
#define MSG_TEMPERATURAS_2  0x02
#define MSG_TEMPERATURAS_3  0x03
#define MSG_TEMPERATURAS_4  0x04

#define MSG_QUEIMAGAS_MEDIDAS 0x01
#define MSG_QUEIMAGAS_CALOR   0x02

const uint32_t TIMEOUT_CAN_MS = 3000;

// ----------------------- Teste do barramento --------------------------------
#define CAN_ID_TESTE        0x123
const bool     ENVIAR_TESTE     = true;  // false = mestra so escuta
const uint32_t INTERVALO_TX_MS  = 500;   // envio do quadro de teste
const uint32_t INTERVALO_STATUS_MS = 500; // impressao do estado do barramento

// =============================== DADOS ======================================

// ----------------------- Temperatura (ID 0x100) ----------------------------
float temperaturas[11] = {
  NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN
};

bool recebeuTemperaturas[4] = {false, false, false, false};
uint32_t ultimaMensagemTemperatura = 0;
bool desconexaoTemperaturaInformada = false;

// ----------------------- Aquecimento (ID 0x200) ----------------------------
float temperaturaReator = NAN;
float tensao = NAN;
float corrente = NAN;
float energiaConsumida = NAN;

bool recebeuMedidas = false;
bool recebeuEnergia = false;
bool desconexaoInformada = false;

uint32_t ultimaMensagemAquecimento = 0;
uint32_t ultimaMensagemMedidas = 0;
uint32_t ultimaMensagemEnergia = 0;

// ----------------------- Queimagas (ID 0x600) ------------------------------
float temperaturaAgua = NAN;
int8_t presencaGas = -1;
int8_t presencaChama = -1;

uint32_t calorJoules = 0;
bool calorValido = false;

bool recebeuMedidasQueimagas = false;
bool recebeuCalorQueimagas = false;
bool desconexaoQueimagasInformada = false;

uint32_t ultimaMensagemQueimagas = 0;

// ----------------------- Status CAN -----------------------------------------
bool canOk = false;

// ============================ INICIALIZACAO =================================
bool iniciarCAN() {

  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(
    (gpio_num_t)CAN_TX_PIN, (gpio_num_t)CAN_RX_PIN, TWAI_MODE_NORMAL);
  twai_timing_config_t  t = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t  f = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g, &t, &f) != ESP_OK || twai_start() != ESP_OK) {
    Serial.println("Falha ao iniciar TWAI");
    Serial.println("[CAN] Falha na inicializacao. Verifique pinos e transceiver.");
    twai_driver_uninstall();
    return false;
  }

  Serial.println("TWAI iniciado");
  Serial.println("[CAN] Interface iniciada em 500 kbps.");
  Serial.println("[CAN] Aguardando:");
  Serial.println("  ID 0x100 - Temperatura");
  Serial.println("  ID 0x200 - Aquecimento");
  Serial.println("  ID 0x600 - Queimagas");

  return true;
}

// ======================== TESTE / ESTADO DO BARRAMENTO =====================
void enviarTeste() {

  static uint8_t cnt = 0;
  static uint32_t ultimoEnvio = 0;

  if (!ENVIAR_TESTE || millis() - ultimoEnvio < INTERVALO_TX_MS) return;
  ultimoEnvio = millis();

  twai_message_t m = {};
  m.identifier = CAN_ID_TESTE;
  m.data_length_code = 1;
  m.data[0] = cnt++;

  // sem espera: a recepcao das escravas nao para enquanto o quadro sai
  Serial.printf("TX: %s\n", esp_err_to_name(twai_transmit(&m, 0)));
}

void monitorarBarramento() {

  static uint32_t ultimoStatus = 0;
  if (millis() - ultimoStatus < INTERVALO_STATUS_MS) return;
  ultimoStatus = millis();

  twai_status_info_t s;
  if (twai_get_status_info(&s) != ESP_OK) return;

  Serial.printf("estado=%d txErr=%lu rxErr=%lu\n", (int)s.state,
                (unsigned long)s.tx_error_counter, (unsigned long)s.rx_error_counter);

  // BUS-OFF: pede recuperacao; quando termina o driver fica parado e precisa de start
  if (s.state == TWAI_STATE_BUS_OFF) {
    twai_initiate_recovery();
  } else if (s.state == TWAI_STATE_STOPPED) {
    twai_start();
  }
}

// ========================== RECEPCAO TEMPERATURA ============================
void receberTemperatura(const twai_message_t &mensagem) {

  if (mensagem.identifier != CAN_ID_TEMPERATURA) return;
  if (mensagem.extd || mensagem.rtr || mensagem.data_length_code != 7) return;

  uint8_t tipoMensagem = mensagem.data[0];

  // Cada temperatura ocupa 2 bytes (Little Endian)
  int16_t dadosRaw[3];

  for (int i = 0; i < 3; i++) {

    uint16_t bits =
      (uint16_t)mensagem.data[1 + i * 2] |
      ((uint16_t)mensagem.data[2 + i * 2] << 8);

    dadosRaw[i] = (int16_t)bits;
  }

  float valores[3];

  for (int i = 0; i < 3; i++) {
    valores[i] = (dadosRaw[i] == INT16_MIN)
                   ? NAN
                   : dadosRaw[i] / 100.0f;
  }

  uint32_t agora = millis();

  // ------------------------ QUADRO 1 --------------------------------------
  if (tipoMensagem == MSG_TEMPERATURAS_1) {

    temperaturas[0] = valores[0];
    temperaturas[1] = valores[1];
    temperaturas[2] = valores[2];

    recebeuTemperaturas[0] = true;

    Serial.println();
    Serial.println("========== TEMPERATURAS / QUADRO 1 ==========");

    for (int i = 0; i < 3; i++) {
      if (!isnan(temperaturas[i])) {
        Serial.printf("T%d: %.2f C\n", i + 1, temperaturas[i]);
      } else {
        Serial.printf("T%d: SEM LEITURA\n", i + 1);
      }
    }

    Serial.println("==============================================");
  }

  // ------------------------ QUADRO 2 --------------------------------------
  else if (tipoMensagem == MSG_TEMPERATURAS_2) {

    temperaturas[3] = valores[0];
    temperaturas[4] = valores[1];
    temperaturas[5] = valores[2];

    recebeuTemperaturas[1] = true;

    Serial.println();
    Serial.println("========== TEMPERATURAS / QUADRO 2 ==========");

    for (int i = 0; i < 3; i++) {
      if (!isnan(temperaturas[i + 3])) {
        Serial.printf("T%d: %.2f C\n", i + 4, temperaturas[i + 3]);
      } else {
        Serial.printf("T%d: SEM LEITURA\n", i + 4);
      }
    }

    Serial.println("==============================================");
  }

  // ------------------------ QUADRO 3 --------------------------------------
  else if (tipoMensagem == MSG_TEMPERATURAS_3) {

    temperaturas[6] = valores[0];
    temperaturas[7] = valores[1];
    temperaturas[8] = valores[2];

    recebeuTemperaturas[2] = true;

    Serial.println();
    Serial.println("========== TEMPERATURAS / QUADRO 3 ==========");

    for (int i = 0; i < 3; i++) {
      if (!isnan(temperaturas[i + 6])) {
        Serial.printf("T%d: %.2f C\n", i + 7, temperaturas[i + 6]);
      } else {
        Serial.printf("T%d: SEM LEITURA\n", i + 7);
      }
    }

    Serial.println("==============================================");
  }

  // ------------------------ QUADRO 4 --------------------------------------
  else if (tipoMensagem == MSG_TEMPERATURAS_4) {

    temperaturas[9] = valores[0];  // T10
    temperaturas[10] = valores[1]; // DHT22

    recebeuTemperaturas[3] = true;

    Serial.println();
    Serial.println("========== TEMPERATURAS / QUADRO 4 ==========");

    if (!isnan(temperaturas[9]))
      Serial.printf("T10: %.2f C\n", temperaturas[9]);
    else
      Serial.println("T10: SEM LEITURA");

    if (!isnan(temperaturas[10]))
      Serial.printf("DHT22: %.2f C\n", temperaturas[10]);
    else
      Serial.println("DHT22: SEM LEITURA");

    Serial.println("==============================================");
  }
  else {
    return;
  }

  ultimaMensagemTemperatura = agora;
  desconexaoTemperaturaInformada = false;
}

// ============================ RECEPCAO AQUECIMENTO ==========================
void receberAquecimento(const twai_message_t &mensagem) {

  if (mensagem.identifier != CAN_ID_AQUECIMENTO) return;
  if (mensagem.extd || mensagem.rtr || mensagem.data_length_code == 0) return;

  uint8_t tipoMensagem = mensagem.data[0];
  uint32_t agora = millis();

  // ------------------------------------------------------------------------
  // Mensagem 0x01: temperatura, tensao e corrente (7 bytes)
  // ------------------------------------------------------------------------
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

    temperaturaReator = (temperaturaRaw == INT16_MIN)
                          ? NAN : temperaturaRaw / 100.0f;

    tensao = (tensaoRaw == UINT16_MAX)
               ? NAN : tensaoRaw / 10.0f;

    corrente = (correnteRaw == UINT16_MAX)
                 ? NAN : correnteRaw / 1000.0f;

    recebeuMedidas = true;
    ultimaMensagemMedidas = agora;
    ultimaMensagemAquecimento = agora;
    desconexaoInformada = false;

    Serial.println();
    Serial.println("========== AQUECIMENTO / MEDIDAS ==========");

    if (!isnan(temperaturaReator))
      Serial.printf("Temperatura do reator: %.2f C\n", temperaturaReator);
    else
      Serial.println("Temperatura do reator: SEM LEITURA");

    if (!isnan(tensao))
      Serial.printf("Tensao: %.1f V\n", tensao);
    else
      Serial.println("Tensao: SEM LEITURA");

    if (!isnan(corrente))
      Serial.printf("Corrente: %.3f A\n", corrente);
    else
      Serial.println("Corrente: SEM LEITURA");

    Serial.println("============================================");
  }

  // ------------------------------------------------------------------------
  // Mensagem 0x02: energia acumulada (5 bytes)
  // ------------------------------------------------------------------------
  else if (tipoMensagem == MSG_ENERGIA && mensagem.data_length_code == 5) {

    uint32_t energiaRaw =
      (uint32_t)mensagem.data[1] |
      ((uint32_t)mensagem.data[2] << 8) |
      ((uint32_t)mensagem.data[3] << 16) |
      ((uint32_t)mensagem.data[4] << 24);

    energiaConsumida = (energiaRaw == UINT32_MAX)
                         ? NAN : energiaRaw / 1000.0f;

    recebeuEnergia = true;
    ultimaMensagemEnergia = agora;
    ultimaMensagemAquecimento = agora;
    desconexaoInformada = false;

    if (!isnan(energiaConsumida))
      Serial.printf("Energia acumulada: %.3f kWh\n", energiaConsumida);
    else
      Serial.println("Energia acumulada: SEM LEITURA");
  }
}

// ======================== RECEPCAO QUEIMAGAS ===============================
void receberQueimagas(const twai_message_t &mensagem) {

  if (mensagem.identifier != CAN_ID_QUEIMAGAS) return;
  if (mensagem.extd || mensagem.rtr || mensagem.data_length_code != 5) return;

  uint8_t tipoMensagem = mensagem.data[0];
  uint32_t agora = millis();

  // ------------------------------------------------------------------------
  // Mensagem 0x01: temperatura da agua, presenca de gas e presenca de chama
  // ------------------------------------------------------------------------
  if (tipoMensagem == MSG_QUEIMAGAS_MEDIDAS) {

    uint16_t temperaturaBits =
      ((uint16_t)mensagem.data[1] << 8) |
      (uint16_t)mensagem.data[2];

    int16_t temperaturaRaw = (int16_t)temperaturaBits;

    temperaturaAgua = (temperaturaRaw == INT16_MIN)
                         ? NAN : temperaturaRaw / 100.0f;

    presencaGas = (mensagem.data[3] <= 1)
                    ? (int8_t)mensagem.data[3] : -1;

    presencaChama = (mensagem.data[4] <= 1)
                      ? (int8_t)mensagem.data[4] : -1;

    recebeuMedidasQueimagas = true;
    ultimaMensagemQueimagas = agora;
    desconexaoQueimagasInformada = false;

    Serial.println();
    Serial.println("========== QUEIMAGAS / MEDIDAS ==========");

    if (!isnan(temperaturaAgua))
      Serial.printf("Temperatura da agua: %.2f C\n", temperaturaAgua);
    else
      Serial.println("Temperatura da agua: SEM LEITURA");

    if (presencaGas == 1)
      Serial.println("Presenca de gas: Yes");
    else if (presencaGas == 0)
      Serial.println("Presenca de gas: No");
    else
      Serial.println("Presenca de gas: DADO INVALIDO");

    if (presencaChama == 1)
      Serial.println("Presenca de chama: Yes");
    else if (presencaChama == 0)
      Serial.println("Presenca de chama: No");
    else
      Serial.println("Presenca de chama: DADO INVALIDO");

    Serial.println("==========================================");
  }

  // ------------------------------------------------------------------------
  // Mensagem 0x02: calor em joules
  // ------------------------------------------------------------------------
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

    recebeuCalorQueimagas = true;
    ultimaMensagemQueimagas = agora;
    desconexaoQueimagasInformada = false;

    if (calorValido)
      Serial.printf("Calor: %lu J\n", (unsigned long)calorJoules);
    else
      Serial.println("Calor: SEM LEITURA");
  }
}

// ======================== PROCESSAMENTO CAN =================================
void processarMensagensCAN() {

  if (!canOk) return;

  twai_message_t mensagem;

  while (twai_receive(&mensagem, 0) == ESP_OK) {

    if (mensagem.identifier == CAN_ID_TEMPERATURA) {
      receberTemperatura(mensagem);
    }

    else if (mensagem.identifier == CAN_ID_AQUECIMENTO) {
      receberAquecimento(mensagem);
    }

    else if (mensagem.identifier == CAN_ID_QUEIMAGAS) {
      receberQueimagas(mensagem);
    }

    else {
      // Qualquer outro ID (ex.: 0x123 de outra placa de teste)
      Serial.printf("RX id=0x%X dado=%d\n", (unsigned)mensagem.identifier,
                    mensagem.data_length_code > 0 ? mensagem.data[0] : 0);
    }
  }
}

// ============================== MONITOR =====================================
void monitorarConexaoCAN() {

  if (!canOk) return;

  // ----------------------- TEMPERATURA -------------------------------------
  if (ultimaMensagemTemperatura != 0 &&
      millis() - ultimaMensagemTemperatura > TIMEOUT_CAN_MS &&
      !desconexaoTemperaturaInformada) {

    Serial.println("[CAN] ATENCAO: sem comunicacao com a escrava Temperatura (ID 0x100).");
    desconexaoTemperaturaInformada = true;
  }

  // ----------------------- AQUECIMENTO -------------------------------------
  if (ultimaMensagemAquecimento != 0 &&
      millis() - ultimaMensagemAquecimento > TIMEOUT_CAN_MS &&
      !desconexaoInformada) {

    Serial.println("[CAN] ATENCAO: sem comunicacao com a escrava de aquecimento (ID 0x200).");
    desconexaoInformada = true;
  }

  // ----------------------- QUEIMAGAS ---------------------------------------
  if (ultimaMensagemQueimagas != 0 &&
      millis() - ultimaMensagemQueimagas > TIMEOUT_CAN_MS &&
      !desconexaoQueimagasInformada) {

    Serial.println("[CAN] ATENCAO: sem comunicacao com a escrava de Queimagas (ID 0x600).");
    desconexaoQueimagasInformada = true;
  }
}

// ================================= SETUP ==================================
void setup() {

  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("============================================");
  Serial.println("       ESP32 MESTRA - SUPERVISOR CAN");
  Serial.println("============================================");

  canOk = iniciarCAN();
}

// ================================= LOOP ===================================
void loop() {

  if (!canOk) return;

  enviarTeste();
  processarMensagensCAN();
  monitorarConexaoCAN();
  monitorarBarramento();
  delay(1);
}
