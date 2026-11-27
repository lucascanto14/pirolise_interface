# Guia: usar o site com a ESP32 mestra pelo USB

O site lê a **saída serial** da ESP32 mestra (o mesmo texto que aparece no Monitor Serial da
Arduino IDE) direto pelo navegador. Não precisa de Wi-Fi, de `.env` nem de programa extra.

Funciona no **Chrome** ou no **Edge** do computador (não funciona no Firefox, Safari nem no celular).

---

## 1. Atualizar o site

Troque o arquivo `src/routes/index.tsx` do projeto pelo `index.tsx` novo (anexo na conversa).

- **No Lovable:** abra o editor de código do projeto, abra `src/routes/index.tsx`, apague tudo,
  cole o conteúdo do arquivo novo e salve. Depois clique em **Publish**.
- **No computador:** substitua o arquivo dentro de `src\routes` da pasta do site.

Se você tinha criado o arquivo `.env` para o ESP falso antigo, pode apagar. Ele não é mais usado.

## 2. Abrir o site

Use **um** dos dois jeitos:

- **Link publicado do Lovable:** abra o link em uma aba própria do Chrome ou do Edge
  (não dentro da pré-visualização do editor do Lovable).
- **No próprio computador:** na pasta do site, rode `npm run dev` e abra `http://localhost:8080`.

## 3. Testar sem a placa (modo simulação)

Clique em **Modo simulação**. O site gera as mesmas linhas que a mestra imprime e a tela começa
a mudar a cada segundo. Mexa no setpoint para ver a temperatura simulada seguir o valor.
Clique em **Parar simulação** para sair.

## 4. Usar com a ESP32 de verdade

1. Grave na mestra o código `esp32/CAN_mestra/CAN_mestra.ino`. O site funciona com os dois
   modos de saída (`SAIDA_JSON 0` texto ou `SAIDA_JSON 1` JSON); o texto é o padrão.
   Ligação do transceiver: **GPIO5 → TX** e **GPIO4 → RX** do transceiver.
   As escravas de temperatura (0x100 externas e 0x300 internas) precisam mandar os valores **× 10** (não mais × 100).
2. Ligue a mestra no computador pelo cabo USB.
3. **Feche o Monitor Serial da Arduino IDE.** Só um programa pode usar a porta de cada vez.
4. No site, clique em **Conectar ESP32 (USB)**.
5. O navegador abre uma lista de portas. Escolha a da ESP32 (algo como `COM3`, "USB Serial",
   "CP210x" ou "CH340") e clique em **Conectar**.
6. O selo no topo fica **ESP32 CONECTADA** e os valores aparecem assim que a escrava de
   aquecimento mandar dados.

Ao conectar, a ESP32 pode reiniciar sozinha. Isso é normal.

---

## O que aparece na tela

| Linha que a mestra imprime | Onde aparece no site |
| --- | --- |
| `Temperatura do reator: 312.45 C` | Temp. Reator, Temp. Processo e gráfico de temperatura |
| `Tensao: 220.5 V` | Tensão (Grupo 6) |
| `Corrente: 9.876 A` | Corrente (Grupo 6) |
| `Energia acumulada: 12.345 kWh` | Energia Acumulada (Grupo 6) |
| `T1: 251.2 C` ... `DHT22: 27.1 C` depois de `TEMPERATURAS / QUADRO n` | Temperaturas Externas e gráfico Temperaturas Externas × Tempo (escrava 0x100) |
| `T1: 251.2 C` ... `DHT22: 27.1 C` depois de `TEMP. INTERNAS / QUADRO n` | Temperaturas Internas e gráfico Temperaturas Internas × Tempo (escrava 0x300) |
| `Massa (bio-oleo): 1.234 kg` | Massa de bio-óleo e gráfico (Grupo 8, escrava Balança 0x500) |
| `Presenca de gas: Sim` / `Nao` | Presença de gás / chama (Queimagas) |
| `... SEM LEITURA` | O valor aparece como "—" |
| `[CAN] ATENCAO: sem comunicacao ...` | Alerta vermelho no Grupo 6 |
| `[CAN] Falha na inicializacao ...` | Alerta vermelho no painel de conexão |
| `[CAN] Erro ao instalar driver ...` | Alerta vermelho no painel de conexão (some quando a mestra imprime `[CAN] Interface iniciada`) |
| Linha JSON `{"can_ok":...}` (modo `SAIDA_JSON 1`) | Todos os valores acima, uma vez por segundo |
| `estado=1 txErr=0 rxErr=0` | Quadro "Barramento CAN" (OK, BUS-OFF, RECUPERANDO, PARADO e contadores de erro) |
| `TX: ESP_OK` | "Último envio" no quadro Barramento CAN (só com `ENVIAR_TESTE = true`) |
| `RX id=0x123 dado=42` | "Teste recebido" no quadro Barramento CAN (qualquer ID fora de 0x100/0x200/0x300/0x500/0x600) |

A potência é calculada no site (tensão × corrente). Nitrogênio e volume do gás
mostram "—" porque ainda não há escrava para eles.

Ligar/desligar e o setpoint não são enviados ao reator: a mestra atual só envia leituras.
O setpoint serve só como linha de referência no gráfico.

---

## Problemas comuns

| O que acontece | O que fazer |
| --- | --- |
| "Não foi possível abrir a porta" | Feche o Monitor Serial da Arduino IDE (ou o Plotter Serial) e tente de novo. |
| A ESP32 não aparece na lista de portas | Troque o cabo USB (alguns só carregam) ou instale o driver CP210x ou CH340. |
| "Este navegador não acessa a porta USB" | Abra o site no Chrome ou no Edge do computador. |
| Conectou, mas os valores ficam "—" | Confira no Monitor Serial se a mestra está recebendo dados da escrava. |
| O botão Conectar não faz nada no Lovable | Abra o link publicado numa aba própria, fora do editor. |
