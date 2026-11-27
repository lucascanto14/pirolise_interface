import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Power,
  Thermometer,
  Wind,
  Gauge,
  Flame,
  Droplets,
  Zap,
  Timer,
  FlaskConical,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Usb,
  Unplug,
  PlayCircle,
  Download,
  RotateCcw,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Supervisório - Pirólise de Biomassa (Arroz)" },
      {
        name: "description",
        content:
          "Dashboard industrial para monitoramento e controle do processo de pirólise da casca de arroz.",
      },
      { property: "og:title", content: "Supervisório - Pirólise de Biomassa" },
      {
        property: "og:description",
        content: "Telemetria em tempo real do reator de pirólise.",
      },
    ],
  }),
  component: Dashboard,
});

// A ESP32 mestra fica ligada no computador pelo cabo USB. O site lê a saída serial
// dela (a mesma que aparece no Monitor Serial da Arduino IDE) direto pelo navegador,
// usando a Web Serial API (funciona no Chrome e no Edge do computador).
const BAUD_RATE = 115200;

// Unidades de cada sensor, agrupadas pela escrava que envia o dado.
//   Temperatura (ID 0x100): T1 a T10 (MAX6675) e DHT22
//   Aquecimento (ID 0x200): temperatura do reator, tensão, corrente e energia
//   Balança     (ID 0x500): massa do bio-óleo
//   Queimagas   (ID 0x600): temperatura da água, presença de gás e de chama, calor
// Nitrogênio e volume do gás ainda não têm escrava (aparecem como "—").
const UNIDADES = {
  t1: "°C",
  t2: "°C",
  t3: "°C",
  t4: "°C",
  t5: "°C",
  t6: "°C",
  t7: "°C",
  t8: "°C",
  t9: "°C",
  t10: "°C",
  dht22: "°C",
  temperatura: "°C",
  tensao: "V",
  corrente: "A",
  energia: "kWh",
  temperaturaAgua: "°C",
  presencaGas: "",
  presencaChama: "",
  calor: "J",
  nitrogenio: "L/min",
  volumeGas: "L",
  massa: "kg",
};

type SensorName = keyof typeof UNIDADES;
const SENSORES = Object.keys(UNIDADES) as SensorName[];

const TERMOPARES: { sensor: SensorName; rotulo: string }[] = [
  ...Array.from({ length: 10 }, (_, i) => ({
    sensor: `t${i + 1}` as SensorName,
    rotulo: `T${i + 1}`,
  })),
  { sensor: "dht22", rotulo: "DHT22" },
];

type Escrava = "temperatura" | "aquecimento" | "balanca" | "queimagas";

// Texto que a mestra imprime antes do ":" em cada linha -> sensor no site e escrava de origem.
// Ex.: "T3: 251.2 C", "Tensao: SEM LEITURA", "Presenca de chama: Sim", "Calor: 1200 J"
const ROTULOS_SERIAL: Record<string, { sensor: SensorName; escrava: Escrava }> = {
  ...Object.fromEntries(
    TERMOPARES.map(({ sensor, rotulo }) => [rotulo, { sensor, escrava: "temperatura" as Escrava }]),
  ),
  "Temperatura do reator": { sensor: "temperatura", escrava: "aquecimento" },
  Tensao: { sensor: "tensao", escrava: "aquecimento" },
  Corrente: { sensor: "corrente", escrava: "aquecimento" },
  "Energia acumulada": { sensor: "energia", escrava: "aquecimento" },
  "Massa (bio-oleo)": { sensor: "massa", escrava: "balanca" },
  "Temperatura da agua": { sensor: "temperaturaAgua", escrava: "queimagas" },
  "Presenca de gas": { sensor: "presencaGas", escrava: "queimagas" },
  "Presenca de chama": { sensor: "presencaChama", escrava: "queimagas" },
  Calor: { sensor: "calor", escrava: "queimagas" },
};

// Aviso de timeout da mestra -> escrava. Ex.: "[CAN] ATENCAO: sem comunicacao com a escrava Temperatura (ID 0x100)."
const ID_ESCRAVA: Record<string, Escrava> = {
  "0x100": "temperatura",
  "0x200": "aquecimento",
  "0x500": "balanca",
  "0x600": "queimagas",
};

type EventoSerial =
  | { tipo: "valor"; sensor: SensorName; escrava: Escrava; valor: number | null }
  | { tipo: "escravaOffline"; escrava: Escrava }
  | { tipo: "erroCan" }
  | { tipo: "canOk" }
  | { tipo: "barramento"; estado: number; txErr: number; rxErr: number }
  | { tipo: "tx"; resultado: string }
  | { tipo: "rx"; id: string; dado: number };

// Estado do driver TWAI impresso pela mestra em "estado=N txErr=A rxErr=B"
const ESTADOS_TWAI: Record<number, { texto: string; ok: boolean }> = {
  0: { texto: "PARADO", ok: false },
  1: { texto: "OK", ok: true },
  2: { texto: "BUS-OFF", ok: false },
  3: { texto: "RECUPERANDO", ok: false },
};

// Interpreta uma linha da saída serial da mestra. Linhas desconhecidas são ignoradas.
function lerLinha(linha: string): EventoSerial | null {
  if (linha.includes("ATENCAO: sem comunicacao")) {
    const id = linha.match(/ID (0x[0-9A-Fa-f]+)/)?.[1]?.toLowerCase();
    const escrava = id ? ID_ESCRAVA[id] : undefined;
    return escrava ? { tipo: "escravaOffline", escrava } : null;
  }
  if (
    linha.includes("[CAN] Falha na inicializacao") ||
    linha.includes("[CAN] Erro ao") ||
    linha.includes("Falha ao iniciar TWAI")
  ) {
    return { tipo: "erroCan" };
  }
  if (linha.includes("[CAN] Interface iniciada")) return { tipo: "canOk" };
  // Teste do barramento: "estado=1 txErr=0 rxErr=0", "TX: ESP_OK", "RX id=0x123 dado=42"
  const st = linha.match(/^estado=(\d+)\s+txErr=(\d+)\s+rxErr=(\d+)/);
  if (st) return { tipo: "barramento", estado: +st[1], txErr: +st[2], rxErr: +st[3] };
  const tx = linha.match(/^TX:\s*(\S+)/);
  if (tx) return { tipo: "tx", resultado: tx[1] };
  const rx = linha.match(/^RX id=(0x[0-9A-Fa-f]+)\s+dado=(-?\d+)/);
  if (rx) return { tipo: "rx", id: rx[1].toUpperCase().replace("0X", "0x"), dado: +rx[2] };
  const m = linha.match(/^([^:]+):\s*(.+)$/);
  if (!m) return null;
  const destino = ROTULOS_SERIAL[m[1].trim()];
  if (!destino) return null;
  const texto = m[2].trim();
  // "Sim"/"Nao" da Queimagas viram 1/0 (aceita também "Yes"/"No" da mestra antiga);
  // "SEM LEITURA" e "DADO INVALIDO" ficam sem valor
  if (texto === "Sim" || texto === "Yes") return { tipo: "valor", ...destino, valor: 1 };
  if (texto === "Nao" || texto === "No") return { tipo: "valor", ...destino, valor: 0 };
  if (texto.startsWith("SEM LEITURA") || texto.startsWith("DADO INVALIDO")) {
    return { tipo: "valor", ...destino, valor: null };
  }
  const valor = parseFloat(texto);
  return Number.isFinite(valor) ? { tipo: "valor", ...destino, valor } : null;
}

// Modo JSON da mestra (SAIDA_JSON 1): uma linha por segundo com tudo.
// Ex.: {"can_ok":true,"barramento":{...},"temperatura":{"online":true,"termopares":[...],"dht22":27.1},...}
type JsonMestra = {
  can_ok?: boolean;
  barramento?: { estado: number | null; tx_err: number; rx_err: number };
  temperatura?: { online: boolean; termopares?: (number | null)[]; dht22?: number | null };
  aquecimento?: {
    online: boolean;
    temperatura_reator?: number | null;
    tensao?: number | null;
    corrente?: number | null;
    energia_kwh?: number | null;
  };
  balanca?: { online: boolean; massa_kg?: number | null };
  queimagas?: {
    online: boolean;
    temperatura_agua?: number | null;
    presenca_gas?: number;
    presenca_chama?: number;
    calor_joules?: number | null;
  };
};

function lerJson(linha: string): EventoSerial[] {
  let d: JsonMestra;
  try {
    d = JSON.parse(linha) as JsonMestra;
  } catch {
    return [];
  }
  const eventos: EventoSerial[] = [];
  if (d.can_ok === false) eventos.push({ tipo: "erroCan" });
  if (d.can_ok === true) eventos.push({ tipo: "canOk" });
  const b = d.barramento;
  if (b && b.estado !== null && b.estado !== undefined) {
    eventos.push({ tipo: "barramento", estado: b.estado, txErr: b.tx_err, rxErr: b.rx_err });
  }
  const num = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const bool01 = (v: number | undefined) => (v === 0 || v === 1 ? v : null);
  const grupo = (
    escrava: Escrava,
    online: boolean | undefined,
    valores: [SensorName, number | null][],
  ) => {
    if (online === undefined) return;
    // escrava sem comunicação: a mestra ainda manda o último valor, que fica velho
    if (!online) {
      eventos.push({ tipo: "escravaOffline", escrava });
      return;
    }
    for (const [sensor, valor] of valores) eventos.push({ tipo: "valor", sensor, escrava, valor });
  };
  const t = d.temperatura;
  grupo("temperatura", t?.online, [
    ...TERMOPARES.slice(0, 10).map(
      ({ sensor }, i) => [sensor, num(t?.termopares?.[i])] as [SensorName, number | null],
    ),
    ["dht22", num(t?.dht22)],
  ]);
  const a = d.aquecimento;
  grupo("aquecimento", a?.online, [
    ["temperatura", num(a?.temperatura_reator)],
    ["tensao", num(a?.tensao)],
    ["corrente", num(a?.corrente)],
    ["energia", num(a?.energia_kwh)],
  ]);
  grupo("balanca", d.balanca?.online, [["massa", num(d.balanca?.massa_kg)]]);
  const q = d.queimagas;
  grupo("queimagas", q?.online, [
    ["temperaturaAgua", num(q?.temperatura_agua)],
    ["presencaGas", bool01(q?.presenca_gas)],
    ["presencaChama", bool01(q?.presenca_chama)],
    ["calor", num(q?.calor_joules)],
  ]);
  return eventos;
}

// Tipos mínimos da Web Serial API (o TypeScript ainda não traz por padrão)
type PortaSerial = {
  open(opts: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
};
type NavegadorComSerial = Navigator & {
  serial?: { requestPort(): Promise<PortaSerial> };
};

type Point = { t: number; v: number };
const MAX_POINTS = 40;

function pushSeries(series: Point[], v: number, t: number): Point[] {
  const next = [...series, { t, v: Number(v.toFixed(2)) }];
  return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
}

// Histórico completo dos termopares durante o ensaio (gráfico temperatura × tempo).
// Uma linha por segundo; cada termopar entra na linha do segundo em que chegou.
type LinhaHistorico = { t: number } & Partial<Record<SensorName, number>>;
const MAX_PONTOS_GRAFICO = 600; // acima disso o gráfico mostra médias por intervalo

const CORES_TERMOPARES = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#d946ef",
  "#94a3b8",
];

// Reduz o histórico para no máximo MAX_PONTOS_GRAFICO pontos (média por intervalo)
function reduzirHistorico(linhas: LinhaHistorico[]): LinhaHistorico[] {
  // cópia: o Recharts só redesenha quando recebe um array novo
  if (linhas.length <= MAX_PONTOS_GRAFICO) return linhas.map((l) => ({ ...l }));
  const passo = Math.ceil(linhas.length / MAX_PONTOS_GRAFICO);
  const saida: LinhaHistorico[] = [];
  for (let i = 0; i < linhas.length; i += passo) {
    const grupo = linhas.slice(i, i + passo);
    const media: LinhaHistorico = { t: grupo[0].t };
    for (const { sensor } of TERMOPARES) {
      const vals = grupo.map((l) => l[sensor]).filter((v): v is number => v !== undefined);
      if (vals.length)
        media[sensor] = Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
    }
    saida.push(media);
  }
  return saida;
}

function fmtTempo(seg: number) {
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const ss = seg % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

function fmt(n: number | null, d = 1) {
  return n === null ? "—" : n.toFixed(d);
}

function simNao(n: number | null) {
  return n === null ? "—" : n === 1 ? "SIM" : "NÃO";
}

type ConnStatus = "desconectado" | "conectando" | "conectado" | "simulacao";

function Dashboard() {
  const [setpoint, setSetpoint] = useState(420);
  const [now, setNow] = useState(new Date());
  const [elapsed, setElapsed] = useState(0);
  const [conn, setConn] = useState<ConnStatus>("desconectado");
  const [erroConexao, setErroConexao] = useState<string | null>(null);
  const [erroCan, setErroCan] = useState(false);
  // teste do barramento CAN (linhas TX / RX / estado da mestra)
  const [barramento, setBarramento] = useState<{
    estado: number;
    txErr: number;
    rxErr: number;
  } | null>(null);
  const [ultimoTx, setUltimoTx] = useState<string | null>(null);
  const [ultimoRx, setUltimoRx] = useState<{ id: string; dado: number } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [serialSuportado, setSerialSuportado] = useState(true);

  // telemetria recebida (null = sem leitura ou ainda não chegou)
  const [valores, setValores] = useState(
    () => Object.fromEntries(SENSORES.map((s) => [s, null])) as Record<SensorName, number | null>,
  );
  const [series, setSeries] = useState(
    () =>
      Object.fromEntries(SENSORES.map((s) => [s, [] as Point[]])) as Record<SensorName, Point[]>,
  );
  // comunicação entre a mestra e cada escrava (null = ainda não informado)
  const [escravaOnline, setEscravaOnline] = useState<Record<Escrava, boolean | null>>({
    temperatura: null,
    aquecimento: null,
    balanca: null,
    queimagas: null,
  });

  const portaRef = useRef<PortaSerial | null>(null);
  const leitorRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const simulacaoRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(Date.now());
  // histórico dos termopares desde o início do ensaio (null = ainda não chegou nada)
  const historicoRef = useRef<LinhaHistorico[]>([]);
  const inicioEnsaioRef = useRef<number | null>(null);
  const [visiveis, setVisiveis] = useState<Record<SensorName, boolean>>(
    () =>
      Object.fromEntries(TERMOPARES.map(({ sensor }) => [sensor, true])) as Record<
        SensorName,
        boolean
      >,
  );

  const online = conn === "conectado" || conn === "simulacao";

  // Web Serial só existe no Chrome/Edge (verificado no navegador, não no servidor)
  useEffect(() => {
    setSerialSuportado("serial" in navigator);
  }, []);

  // relógio
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // tempo de monitoramento (enquanto conectado)
  useEffect(() => {
    if (!online) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [online]);

  const processarLinha = (linha: string) => {
    const texto = linha.trim();
    if (texto.startsWith("{")) {
      lerJson(texto).forEach(processarEvento);
      return;
    }
    const evento = lerLinha(texto);
    if (evento) processarEvento(evento);
  };

  const processarEvento = (evento: EventoSerial) => {
    if (evento.tipo === "escravaOffline") {
      setEscravaOnline((e) => ({ ...e, [evento.escrava]: false }));
      return;
    }
    if (evento.tipo === "erroCan") {
      setErroCan(true);
      return;
    }
    if (evento.tipo === "canOk") {
      setErroCan(false);
      return;
    }
    if (evento.tipo === "barramento") {
      const { estado, txErr, rxErr } = evento;
      setBarramento({ estado, txErr, rxErr });
      return;
    }
    if (evento.tipo === "tx") {
      setUltimoTx(evento.resultado);
      return;
    }
    if (evento.tipo === "rx") {
      setUltimoRx({ id: evento.id, dado: evento.dado });
      return;
    }

    const { sensor, escrava, valor } = evento;
    setEscravaOnline((e) => (e[escrava] ? e : { ...e, [escrava]: true }));
    setValores((v) => ({ ...v, [sensor]: valor }));
    if (valor !== null) {
      const t = Math.round((Date.now() - startRef.current) / 1000);
      setSeries((s) => ({ ...s, [sensor]: pushSeries(s[sensor], valor, t) }));
      if (escrava === "temperatura") registrarHistorico(sensor, valor);
    }
    setLastUpdate(new Date());
  };

  function registrarHistorico(sensor: SensorName, valor: number) {
    const agora = Date.now();
    if (inicioEnsaioRef.current === null) inicioEnsaioRef.current = agora;
    const t = Math.round((agora - inicioEnsaioRef.current) / 1000);
    const hist = historicoRef.current;
    const ultima = hist[hist.length - 1];
    if (ultima && ultima.t === t) ultima[sensor] = valor;
    else hist.push({ t, [sensor]: valor });
  }

  const zerarHistorico = () => {
    historicoRef.current = [];
    inicioEnsaioRef.current = null;
    setNow(new Date());
  };

  // CSV com todas as leituras do ensaio (sem redução), separador ";" para o Excel em português
  const baixarCsv = () => {
    const cab = ["tempo_s", ...TERMOPARES.map(({ rotulo }) => `${rotulo}_C`)].join(";");
    const linhas = historicoRef.current.map((l) =>
      [l.t, ...TERMOPARES.map(({ sensor }) => (l[sensor] ?? "").toString().replace(".", ","))].join(
        ";",
      ),
    );
    const blob = new Blob([[cab, ...linhas].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `termopares_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pararSimulacao = () => {
    if (simulacaoRef.current) clearInterval(simulacaoRef.current);
    simulacaoRef.current = null;
  };

  const desconectar = async () => {
    pararSimulacao();
    try {
      await leitorRef.current?.cancel();
    } catch {
      /* já estava fechado */
    }
    leitorRef.current = null;
    try {
      await portaRef.current?.close();
    } catch {
      /* já estava fechada */
    }
    portaRef.current = null;
    setConn("desconectado");
  };

  const conectarSerial = async () => {
    const serial = (navigator as NavegadorComSerial).serial;
    if (!serial) {
      setErroConexao(
        "Este navegador não acessa a porta USB. Abra o site no Chrome ou no Edge do computador.",
      );
      return;
    }
    setErroConexao(null);
    setErroCan(false);
    setBarramento(null);
    setUltimoTx(null);
    setUltimoRx(null);
    pararSimulacao();

    let porta: PortaSerial;
    try {
      porta = await serial.requestPort(); // o navegador abre a lista de portas
    } catch {
      return; // usuário fechou a janela sem escolher
    }

    try {
      setConn("conectando");
      await porta.open({ baudRate: BAUD_RATE });
    } catch {
      setConn("desconectado");
      setErroConexao(
        "Não foi possível abrir a porta. Feche o Monitor Serial da Arduino IDE (ou outro programa usando a porta) e tente de novo.",
      );
      return;
    }
    portaRef.current = porta;
    setConn("conectado");

    // lê o texto da serial e separa em linhas
    const leitor = porta
      .readable!.pipeThrough(
        new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>,
      )
      .getReader();
    leitorRef.current = leitor;
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await leitor.read();
        if (done) break;
        buffer += value;
        const linhas = buffer.split("\n");
        buffer = linhas.pop() ?? "";
        linhas.forEach(processarLinha);
      }
    } catch {
      setErroConexao(
        "A conexão USB com a ESP32 caiu. Confira o cabo e clique em Conectar de novo.",
      );
    }
    leitor.releaseLock();
    try {
      await porta.close();
    } catch {
      /* já estava fechada */
    }
    if (portaRef.current === porta) {
      portaRef.current = null;
      leitorRef.current = null;
      setConn("desconectado");
    }
  };

  // a simulação lê o setpoint atual sem reiniciar o intervalo
  const setpointRef = useRef(setpoint);
  useEffect(() => {
    setpointRef.current = setpoint;
  }, [setpoint]);

  // Modo simulação: gera as mesmas linhas que a mestra imprime, para testar sem a placa
  const iniciarSimulacao = async () => {
    await desconectar();
    setErroConexao(null);
    setErroCan(false);
    setBarramento(null);
    setUltimoTx(null);
    setUltimoRx(null);
    zerarHistorico();
    setConn("simulacao");
    let temperatura = 25;
    let energia = 0;
    let calor = 0;
    let agua = 24;
    let massa = 0;
    let t = 0;
    const linhaTemp = (rotulo: string, v: number | null) =>
      processarLinha(v === null ? `${rotulo}: SEM LEITURA` : `${rotulo}: ${v.toFixed(1)} C`);
    simulacaoRef.current = setInterval(() => {
      t += 1;
      const sp = setpointRef.current;
      temperatura += (sp - temperatura) * 0.05 + (Math.random() - 0.5) * 3;

      // Escrava Aquecimento (ID 0x200)
      const tensao = 218 + Math.random() * 4;
      const corrente = temperatura < sp - 5 ? 9 + Math.sin(t / 7) + Math.random() * 0.3 : 3;
      energia += (tensao * corrente) / 3_600_000;
      processarLinha("========== AQUECIMENTO / MEDIDAS ==========");
      processarLinha(`Temperatura do reator: ${temperatura.toFixed(2)} C`);
      processarLinha(`Tensao: ${tensao.toFixed(1)} V`);
      processarLinha(`Corrente: ${corrente.toFixed(3)} A`);
      if (t % 5 === 0) processarLinha(`Energia acumulada: ${energia.toFixed(3)} kWh`);

      // Escrava Temperatura (ID 0x100): um quadro por segundo, em rodízio
      const quadro = ((t - 1) % 4) + 1;
      processarLinha(`========== TEMPERATURAS / QUADRO ${quadro} ==========`);
      const perfil = (i: number) =>
        25 + (temperatura - 25) * (1 - i * 0.08) + (Math.random() - 0.5) * 2;
      if (quadro < 4) {
        for (let i = 0; i < 3; i++) {
          const n = (quadro - 1) * 3 + i + 1;
          linhaTemp(`T${n}`, n === 8 ? null : perfil(n - 1)); // T8 simula termopar sem leitura
        }
      } else {
        linhaTemp("T10", perfil(9));
        linhaTemp("DHT22", 27 + Math.random());
      }

      // Escrava Queimagas (ID 0x600)
      const quente = temperatura > 300;
      agua += ((quente ? 60 : 25) - agua) * 0.02;
      calor += quente ? 800 + Math.round(Math.random() * 100) : 0;
      processarLinha("========== QUEIMAGAS / MEDIDAS ==========");
      processarLinha(`Temperatura da agua: ${agua.toFixed(2)} C`);
      processarLinha(`Presenca de gas: ${quente ? "Sim" : "Nao"}`);
      processarLinha(`Presenca de chama: ${quente ? "Sim" : "Nao"}`);
      processarLinha(`Calor: ${calor} J`);

      // Escrava Balança (ID 0x500): bio-óleo condensado acumulando
      if (quente) massa += 0.002 + Math.random() * 0.001;
      processarLinha(`Massa (bio-oleo): ${massa.toFixed(3)} kg`);

      // Teste do barramento (quadro 0x123 com contador e estado do TWAI)
      processarLinha("TX: ESP_OK");
      processarLinha(`RX id=0x123 dado=${t % 256}`);
      processarLinha("estado=1 txErr=0 rxErr=0");
    }, 1000);
  };

  // fecha a porta e para a simulação ao sair da página
  useEffect(() => {
    return () => {
      void desconectar();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const temp = valores.temperatura;
  // gás detectado sem chama no queimador
  const gasSemChama = valores.presencaGas === 1 && valores.presencaChama === 0;
  // atualiza o gráfico do ensaio uma vez por segundo (junto com o relógio)
  const historicoGrafico = useMemo(
    () => reduzirHistorico(historicoRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now],
  );
  const duracaoEnsaio = historicoRef.current.length
    ? historicoRef.current[historicoRef.current.length - 1].t
    : 0;
  const potencia =
    valores.tensao !== null && valores.corrente !== null ? valores.tensao * valores.corrente : null;

  const clock = useMemo(
    () =>
      now.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    [now],
  );
  const dateStr = useMemo(
    () =>
      now.toLocaleDateString("pt-BR", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
    [now],
  );

  const elapsedStr = useMemo(() => {
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [elapsed]);

  return (
    <main className="mx-auto max-w-[1600px] px-4 py-6 md:px-8 md:py-8">
      {/* HEADER */}
      <header className="mb-6 flex flex-col gap-4 rounded-2xl panel-grad border border-border p-5 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <div className="relative grid h-12 w-12 place-items-center rounded-xl bg-background border border-border">
            <FlaskConical className="h-6 w-6 text-neon" />
            <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-neon shadow-[0_0_12px_var(--neon)] animate-pulse" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight md:text-xl">
              Sistema de Supervisório
            </h1>
            <p className="text-xs text-muted-foreground md:text-sm">
              Pirólise de Biomassa · Casca de Arroz
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <ConnBadge status={conn} />
          <div className="rounded-xl border border-border bg-background/60 px-4 py-2">
            <div className="text-mono text-2xl leading-none text-neon">{clock}</div>
            <div className="mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
              {dateStr}
            </div>
          </div>
        </div>
      </header>

      {/* CONEXÃO + SETPOINT */}
      <section className="mb-6 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-2xl panel-grad border border-border p-5">
          <SectionTitle icon={<Usb className="h-4 w-4" />} label="Conexão com a ESP32 Mestra" />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {online ? (
              <button
                onClick={() => void desconectar()}
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background/40 px-5 py-3 text-sm font-semibold hover:border-danger hover:text-danger transition"
              >
                <Unplug className="h-4 w-4" />
                {conn === "simulacao" ? "Parar simulação" : "Desconectar"}
              </button>
            ) : (
              <button
                onClick={() => void conectarSerial()}
                disabled={conn === "conectando"}
                className="inline-flex items-center gap-2 rounded-xl border border-neon bg-neon/15 px-5 py-3 text-sm font-semibold text-neon glow-neon transition disabled:opacity-50"
              >
                <Usb className="h-4 w-4" />
                Conectar ESP32 (USB)
              </button>
            )}
            {!online && (
              <button
                onClick={() => void iniciarSimulacao()}
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background/40 px-5 py-3 text-sm hover:border-cyan hover:text-cyan transition"
              >
                <PlayCircle className="h-4 w-4" />
                Modo simulação
              </button>
            )}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Ligue a ESP32 mestra no computador pelo cabo USB, feche o Monitor Serial da Arduino IDE
            e clique em Conectar. O navegador vai pedir para escolher a porta (COM). Funciona no
            Chrome e no Edge.
          </p>
          {!serialSuportado && (
            <p className="mt-2 text-xs text-warn">
              Este navegador não acessa a porta USB. Use o Chrome ou o Edge do computador.
            </p>
          )}
          {erroConexao && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-danger/50 bg-danger/10 px-4 py-2.5 text-xs text-danger">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {erroConexao}
            </div>
          )}
          {erroCan && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-danger/50 bg-danger/10 px-4 py-2.5 text-xs text-danger">
              <AlertTriangle className="h-4 w-4 shrink-0" />A mestra informou falha ao iniciar o
              CAN. Verifique os pinos e o transceiver.
            </div>
          )}
          {barramento && (
            <div className="mt-3 rounded-xl border border-border bg-background/40 px-4 py-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="uppercase tracking-widest text-muted-foreground">
                  Barramento CAN
                </span>
                <span
                  className={`text-mono font-semibold ${
                    ESTADOS_TWAI[barramento.estado]?.ok ? "text-neon" : "text-danger"
                  }`}
                >
                  {ESTADOS_TWAI[barramento.estado]?.texto ?? `ESTADO ${barramento.estado}`}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-mono text-muted-foreground">
                <span>Erros TX: {barramento.txErr}</span>
                <span>Erros RX: {barramento.rxErr}</span>
                <span>Último envio: {ultimoTx ?? "—"}</span>
                <span>Teste recebido: {ultimoRx ? `${ultimoRx.id} = ${ultimoRx.dado}` : "—"}</span>
              </div>
            </div>
          )}

          <div className="mt-6 border-t border-border pt-5">
            <div className="flex items-baseline justify-between">
              <label className="text-xs uppercase tracking-widest text-muted-foreground">
                Setpoint · Referência no gráfico
              </label>
              <span className="text-mono text-3xl text-neon">
                {setpoint}
                <span className="ml-1 text-sm text-muted-foreground">°C</span>
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={600}
              step={5}
              value={setpoint}
              onChange={(e) => setSetpoint(Number(e.target.value))}
              className="mt-3 w-full accent-[color:var(--neon)]"
            />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground text-mono">
              <span>0°C</span>
              <span>300°C</span>
              <span>600°C</span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
              {[300, 420, 550].map((p) => (
                <button
                  key={p}
                  onClick={() => setSetpoint(p)}
                  className="rounded-lg border border-border bg-background/40 py-2 text-mono hover:border-neon hover:text-neon transition"
                >
                  {p}°C
                </button>
              ))}
            </div>
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Power className="h-3.5 w-3.5" />A mestra atual só envia leituras. Ligar/desligar e o
              setpoint ainda não são enviados ao reator.
            </p>
          </div>
        </div>

        <div className="rounded-2xl panel-grad border border-border p-5">
          <SectionTitle icon={<Activity className="h-4 w-4" />} label="Telemetria Crítica" />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Metric
              icon={<Thermometer className="h-4 w-4 text-neon" />}
              label="Temp. Reator"
              value={fmt(temp, 0)}
              unit={UNIDADES.temperatura}
              tone="neon"
              compact
            />
            <Metric
              icon={<Zap className="h-4 w-4 text-warn" />}
              label="Potência"
              value={fmt(potencia, 0)}
              unit="W"
              tone="warn"
              compact
            />
            <Metric
              icon={<Flame className="h-4 w-4 text-warn" />}
              label="Chama"
              value={simNao(valores.presencaChama)}
              unit=""
              tone="warn"
              compact
            />
            <Metric
              icon={<Wind className="h-4 w-4 text-cyan" />}
              label="Gás"
              value={simNao(valores.presencaGas)}
              unit=""
              tone="cyan"
              compact
            />
          </div>
        </div>
      </section>

      {/* SUBGROUPS */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* GRUPO 2 */}
        <Card tag="Grupo 2" title="Fluxo de Nitrogênio" icon={<Wind className="h-4 w-4" />}>
          <Metric
            icon={<Wind className="h-4 w-4 text-cyan" />}
            label="Nitrogênio"
            value={fmt(valores.nitrogenio, 2)}
            unit={UNIDADES.nitrogenio}
          />
          <Spark data={series.nitrogenio} color="var(--cyan)" />
        </Card>

        {/* TEMPERATURAS (ID 0x100) */}
        <Card
          tag="Escrava Temperatura · ID 0x100"
          title="Temperaturas do Reator"
          icon={<Thermometer className="h-4 w-4" />}
          className="md:col-span-2"
        >
          <AvisoOffline online={escravaOnline.temperatura} nome="Temperatura" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
            {TERMOPARES.map(({ sensor, rotulo }) => (
              <Metric
                key={sensor}
                icon={<Thermometer className="h-4 w-4 text-neon" />}
                label={rotulo}
                value={fmt(valores[sensor], 1)}
                unit={UNIDADES[sensor]}
                compact
              />
            ))}
          </div>
        </Card>

        {/* GRÁFICO TEMPERATURA × TEMPO (todos os termopares, ensaio inteiro) */}
        <Card
          tag="Escrava Temperatura · ID 0x100"
          title="Temperatura × Tempo do Ensaio"
          icon={<Activity className="h-4 w-4" />}
          className="md:col-span-2 xl:col-span-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="text-mono">
              Duração: {fmtTempo(duracaoEnsaio)} · {historicoRef.current.length} leituras
            </span>
            <div className="flex gap-2">
              <button
                onClick={baixarCsv}
                disabled={!historicoRef.current.length}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-1.5 hover:border-cyan hover:text-cyan transition disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                Baixar CSV
              </button>
              <button
                onClick={zerarHistorico}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-1.5 hover:border-danger hover:text-danger transition"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Novo ensaio
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {TERMOPARES.map(({ sensor, rotulo }, i) => (
              <button
                key={sensor}
                onClick={() => setVisiveis((v) => ({ ...v, [sensor]: !v[sensor] }))}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] text-mono transition ${
                  visiveis[sensor]
                    ? "border-border bg-background/60 text-foreground"
                    : "border-border/40 text-muted-foreground opacity-50"
                }`}
              >
                <span
                  className="inline-block h-2 w-3 rounded"
                  style={{ background: CORES_TERMOPARES[i] }}
                />
                {rotulo}
              </button>
            ))}
          </div>
          <div className="h-80">
            {historicoGrafico.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={historicoGrafico}
                  margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
                >
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={fmtTempo}
                    tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  />
                  <YAxis
                    unit=" °C"
                    tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                    width={60}
                  />
                  <Tooltip
                    labelFormatter={(t) => `Tempo ${fmtTempo(Number(t))}`}
                    formatter={(v) => `${Number(v).toFixed(1)} °C`}
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  {TERMOPARES.map(({ sensor, rotulo }, i) =>
                    visiveis[sensor] ? (
                      <Line
                        key={sensor}
                        type="monotone"
                        dataKey={sensor}
                        name={rotulo}
                        stroke={CORES_TERMOPARES[i]}
                        strokeWidth={1.8}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ) : null,
                  )}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="grid h-full place-items-center text-xs text-muted-foreground">
                O gráfico começa quando a escrava Temperatura enviar a primeira leitura.
              </div>
            )}
          </div>
        </Card>

        {/* QUEIMAGAS (ID 0x600) */}
        <Card
          tag="Escrava Queimagas · ID 0x600"
          title="Queima e Segurança"
          icon={<Flame className="h-4 w-4" />}
        >
          <AvisoOffline online={escravaOnline.queimagas} nome="Queimagas" />
          {gasSemChama ? (
            <div className="flex items-center gap-2 rounded-xl border border-danger/50 bg-danger/10 px-4 py-2.5 text-xs font-semibold text-danger">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Estado: Perigo, há gás mas não há chama
            </div>
          ) : valores.presencaGas !== null && valores.presencaChama !== null ? (
            <div className="flex items-center gap-2 rounded-xl border border-neon/40 bg-neon/10 px-4 py-2.5 text-xs font-semibold text-neon">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Estado: Estável
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Metric
              icon={<Droplets className="h-4 w-4 text-cyan" />}
              label="Temp. Água"
              value={fmt(valores.temperaturaAgua, 1)}
              unit={UNIDADES.temperaturaAgua}
              compact
            />
            <Metric
              icon={<Flame className="h-4 w-4 text-warn" />}
              label="Calor"
              value={fmt(valores.calor, 0)}
              unit={UNIDADES.calor}
              compact
              tone="warn"
            />
          </div>
          <SimNaoBadge label="Presença de gás" valor={valores.presencaGas} />
          <SimNaoBadge label="Presença de chama" valor={valores.presencaChama} />
        </Card>

        {/* GRUPO 4 */}
        <Card tag="Grupo 4" title="Fluxo de Gases" icon={<Wind className="h-4 w-4" />}>
          <Metric
            icon={<CircleDot className="h-4 w-4 text-neon" />}
            label="Volume do Gás"
            value={fmt(valores.volumeGas, 2)}
            unit={UNIDADES.volumeGas}
          />
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={series.volumeGas}
                margin={{ top: 5, right: 5, left: -20, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="gPyro" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--neon)" stopOpacity={0.7} />
                    <stop offset="100%" stopColor="var(--neon)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <Tooltip
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="var(--neon)"
                  strokeWidth={2}
                  fill="url(#gPyro)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* GRUPO 6 */}
        <Card
          tag="Grupo 6 · Escrava Aquecimento · ID 0x200"
          title="Eficiência Energética e Aquecimento"
          icon={<Zap className="h-4 w-4" />}
          className="md:col-span-2"
        >
          <AvisoOffline online={escravaOnline.aquecimento} nome="Aquecimento" />
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              icon={<Zap className="h-4 w-4 text-warn" />}
              label="Tensão"
              value={fmt(valores.tensao, 1)}
              unit={UNIDADES.tensao}
              compact
            />
            <Metric
              icon={<Zap className="h-4 w-4 text-warn" />}
              label="Corrente"
              value={fmt(valores.corrente, 3)}
              unit={UNIDADES.corrente}
              compact
            />
            <Metric
              icon={<Zap className="h-4 w-4 text-warn" />}
              label="Potência"
              value={fmt(potencia, 0)}
              unit="W"
              compact
              tone="warn"
            />
            <Metric
              icon={<Activity className="h-4 w-4 text-cyan" />}
              label="Energia Acumulada"
              value={fmt(valores.energia, 3)}
              unit={UNIDADES.energia}
              compact
            />
            <Metric
              icon={<Thermometer className="h-4 w-4 text-neon" />}
              label="Temp. Processo"
              value={fmt(temp, 0)}
              unit={UNIDADES.temperatura}
              compact
              tone="neon"
            />
            <Metric
              icon={<Timer className="h-4 w-4 text-cyan" />}
              label="Tempo Monitorando"
              value={elapsedStr}
              unit=""
              compact
              mono
            />
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={series.temperatura}
                margin={{ top: 10, right: 10, left: -15, bottom: 0 }}
              >
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <YAxis domain={[0, 650]} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <Tooltip
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="v"
                  stroke="var(--neon)"
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                />
                {/* setpoint reference */}
                <Line
                  type="monotone"
                  dataKey={() => setpoint}
                  data={series.temperatura}
                  stroke="var(--cyan)"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <span className="inline-block h-2 w-4 rounded bg-neon" /> Temperatura
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="inline-block h-2 w-4 rounded bg-cyan" /> Setpoint
            </span>
          </div>
        </Card>

        {/* GRUPO 8 */}
        <Card
          tag="Grupo 8 · Escrava Balança · ID 0x500"
          title="Subproduto · Bio-óleo"
          icon={<Droplets className="h-4 w-4" />}
        >
          <AvisoOffline online={escravaOnline.balanca} nome="Balança" />
          <div className="rounded-xl border border-border bg-background/40 p-4">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">
              Massa de bio-óleo
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-mono text-4xl text-warn">{fmt(valores.massa, 3)}</span>
              <span className="text-sm text-muted-foreground">{UNIDADES.massa}</span>
            </div>
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series.massa} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="gBio" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--warn)" stopOpacity={0.7} />
                    <stop offset="100%" stopColor="var(--warn)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <Tooltip
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="var(--warn)"
                  strokeWidth={2}
                  fill="url(#gBio)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </section>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {conn === "simulacao"
            ? "Modo simulação (dados gerados no navegador)"
            : "Telemetria ao vivo · ESP32 mestra via USB"}
          {lastUpdate && ` · último dado às ${lastUpdate.toLocaleTimeString("pt-BR")}`}
        </span>
        <span className="text-mono">PIRO-RICE · v1.3</span>
      </footer>
    </main>
  );
}

/* ----------------- subcomponents ----------------- */

function ConnBadge({ status }: { status: ConnStatus }) {
  const ok = status === "conectado" || status === "simulacao";
  return (
    <div
      className={`flex items-center gap-2 rounded-xl border px-4 py-2 ${
        ok ? "border-cyan/40 bg-cyan/10 text-cyan" : "border-warn/40 bg-warn/10 text-warn"
      }`}
    >
      {ok ? <Usb className="h-4 w-4" /> : <Unplug className="h-4 w-4" />}
      <span className="text-xs font-bold tracking-[0.18em]">
        {status === "conectado"
          ? "ESP32 CONECTADA"
          : status === "simulacao"
            ? "SIMULAÇÃO"
            : status === "conectando"
              ? "CONECTANDO..."
              : "ESP32 DESCONECTADA"}
      </span>
    </div>
  );
}

function SectionTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
      <span className="grid h-7 w-7 place-items-center rounded-md bg-background/60 border border-border text-neon">
        {icon}
      </span>
      {label}
    </div>
  );
}

function Card({
  tag,
  title,
  icon,
  children,
  className = "",
}: {
  tag: string;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl panel-grad border border-border p-5 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.6)] ${className}`}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-background/60 border border-border text-neon">
            {icon}
          </span>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {tag}
            </div>
            <div className="text-sm font-semibold">{title}</div>
          </div>
        </div>
        <span className="h-2 w-2 rounded-full bg-neon shadow-[0_0_10px_var(--neon)]" />
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  unit,
  tone,
  compact,
  mono,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  unit: string;
  tone?: "neon" | "cyan" | "warn";
  compact?: boolean;
  mono?: boolean;
}) {
  const toneCls =
    tone === "neon"
      ? "text-neon"
      : tone === "cyan"
        ? "text-cyan"
        : tone === "warn"
          ? "text-warn"
          : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-background/40 px-4 py-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className={`${compact ? "text-xl" : "text-2xl"} ${
            mono ? "text-mono" : "text-mono"
          } font-semibold ${toneCls}`}
        >
          {value}
        </span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

function Spark({ data, color }: { data: Point[]; color: string }) {
  return (
    <div className="h-14">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function AvisoOffline({ online, nome }: { online: boolean | null; nome: string }) {
  if (online !== false) return null;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-danger/50 bg-danger/10 px-4 py-2.5 text-xs text-danger">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      Sem comunicação com a escrava {nome} (últimos valores mostrados)
    </div>
  );
}

function SimNaoBadge({ label, valor }: { label: string; valor: number | null }) {
  const sim = valor === 1;
  return (
    <div
      className={`flex items-center justify-between rounded-xl border px-3 py-2.5 transition-colors ${
        sim
          ? "border-warn/50 bg-warn/10 text-warn"
          : "border-border bg-background/40 text-muted-foreground"
      }`}
    >
      <span className="flex items-center gap-2 text-xs">
        {sim ? <Flame className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-neon" />}
        {label}
      </span>
      <span className={`text-xs font-bold tracking-widest ${sim ? "" : "text-foreground"}`}>
        {simNao(valor)}
      </span>
    </div>
  );
}
