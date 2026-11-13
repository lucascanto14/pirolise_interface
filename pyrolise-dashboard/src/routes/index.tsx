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

// Unidades de cada sensor. Temperatura, tensão, corrente e energia vêm da escrava de
// aquecimento (ID 0x200). As demais ainda não têm escrava; confirmem e ajustem aqui.
const UNIDADES = {
  temperatura: "°C",
  tensao: "V",
  corrente: "A",
  energia: "kWh",
  nitrogenio: "L/min",
  volumeGas: "L",
  biooleo: "ml",
  queima: "",
};

type SensorName = keyof typeof UNIDADES;
const SENSORES = Object.keys(UNIDADES) as SensorName[];

// Texto que a mestra imprime antes do ":" em cada linha -> sensor no site.
// Ex.: "Temperatura do reator: 312.45 C" ou "Tensao: SEM LEITURA"
const ROTULOS_SERIAL: Record<string, SensorName> = {
  "Temperatura do reator": "temperatura",
  Tensao: "tensao",
  Corrente: "corrente",
  "Energia acumulada": "energia",
};

type EventoSerial =
  | { tipo: "valor"; sensor: SensorName; valor: number | null }
  | { tipo: "escravaOffline" }
  | { tipo: "erroCan" };

// Interpreta uma linha da saída serial da mestra. Linhas desconhecidas são ignoradas.
function lerLinha(linha: string): EventoSerial | null {
  if (linha.includes("ATENCAO: sem comunicacao")) return { tipo: "escravaOffline" };
  if (linha.includes("[CAN] Falha na inicializacao") || linha.includes("[CAN] Erro ao")) {
    return { tipo: "erroCan" };
  }
  const m = linha.match(/^([^:]+):\s*(.+)$/);
  if (!m) return null;
  const sensor = ROTULOS_SERIAL[m[1].trim()];
  if (!sensor) return null;
  if (m[2].startsWith("SEM LEITURA")) return { tipo: "valor", sensor, valor: null };
  const valor = parseFloat(m[2]);
  return Number.isFinite(valor) ? { tipo: "valor", sensor, valor } : null;
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

function fmt(n: number | null, d = 1) {
  return n === null ? "—" : n.toFixed(d);
}

type ConnStatus = "desconectado" | "conectando" | "conectado" | "simulacao";

function Dashboard() {
  const [setpoint, setSetpoint] = useState(420);
  const [now, setNow] = useState(new Date());
  const [elapsed, setElapsed] = useState(0);
  const [conn, setConn] = useState<ConnStatus>("desconectado");
  const [erroConexao, setErroConexao] = useState<string | null>(null);
  const [erroCan, setErroCan] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [serialSuportado, setSerialSuportado] = useState(true);

  // telemetria recebida (null = sem leitura ou ainda não chegou)
  const [valores, setValores] = useState(
    () => Object.fromEntries(SENSORES.map((s) => [s, null])) as Record<SensorName, number | null>,
  );
  const [series, setSeries] = useState(
    () => Object.fromEntries(SENSORES.map((s) => [s, [] as Point[]])) as Record<SensorName, Point[]>,
  );
  // comunicação entre a mestra e a escrava de aquecimento (null = ainda não informado)
  const [aquecimentoOnline, setAquecimentoOnline] = useState<boolean | null>(null);

  const portaRef = useRef<PortaSerial | null>(null);
  const leitorRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const simulacaoRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(Date.now());

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
    const evento = lerLinha(linha.trim());
    if (!evento) return;

    if (evento.tipo === "escravaOffline") {
      setAquecimentoOnline(false);
      return;
    }
    if (evento.tipo === "erroCan") {
      setErroCan(true);
      return;
    }

    const { sensor, valor } = evento;
    setAquecimentoOnline(true);
    setValores((v) => ({ ...v, [sensor]: valor }));
    if (valor !== null) {
      const t = Math.round((Date.now() - startRef.current) / 1000);
      setSeries((s) => ({ ...s, [sensor]: pushSeries(s[sensor], valor, t) }));
    }
    setLastUpdate(new Date());
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
      setErroConexao("Este navegador não acessa a porta USB. Abra o site no Chrome ou no Edge do computador.");
      return;
    }
    setErroConexao(null);
    setErroCan(false);
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
    const leitor = porta.readable!.pipeThrough(new TextDecoderStream()).getReader();
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
      setErroConexao("A conexão USB com a ESP32 caiu. Confira o cabo e clique em Conectar de novo.");
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
    setConn("simulacao");
    let temperatura = 25;
    let energia = 0;
    let t = 0;
    simulacaoRef.current = setInterval(() => {
      t += 1;
      temperatura += (setpointRef.current - temperatura) * 0.05 + (Math.random() - 0.5) * 3;
      const tensao = 218 + Math.random() * 4;
      const corrente = temperatura < setpointRef.current - 5 ? 9 + Math.sin(t / 7) + Math.random() * 0.3 : 3;
      energia += (tensao * corrente) / 3_600_000;
      processarLinha("========== AQUECIMENTO / MEDIDAS ==========");
      processarLinha(`Temperatura do reator: ${temperatura.toFixed(2)} C`);
      processarLinha(`Tensao: ${tensao.toFixed(1)} V`);
      processarLinha(`Corrente: ${corrente.toFixed(3)} A`);
      if (t % 5 === 0) processarLinha(`Energia acumulada: ${energia.toFixed(3)} kWh`);
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
            Ligue a ESP32 mestra no computador pelo cabo USB, feche o Monitor Serial da Arduino IDE e
            clique em Conectar. O navegador vai pedir para escolher a porta (COM). Funciona no Chrome
            e no Edge.
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
              <AlertTriangle className="h-4 w-4 shrink-0" />
              A mestra informou falha ao iniciar o CAN. Verifique os pinos e o transceiver.
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
              <Power className="h-3.5 w-3.5" />
              A mestra atual só envia leituras. Ligar/desligar e o setpoint ainda não são enviados ao reator.
            </p>
          </div>
        </div>

        <div className="rounded-2xl panel-grad border border-border p-5">
          <SectionTitle icon={<Activity className="h-4 w-4" />} label="Telemetria Crítica" />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Metric icon={<Thermometer className="h-4 w-4 text-neon" />} label="Temp. Reator" value={fmt(temp, 0)} unit={UNIDADES.temperatura} tone="neon" compact />
            <Metric icon={<Zap className="h-4 w-4 text-warn" />} label="Potência" value={fmt(potencia, 0)} unit="W" tone="warn" compact />
            <Metric icon={<Wind className="h-4 w-4 text-cyan" />} label="Nitrogênio" value={fmt(valores.nitrogenio, 2)} unit={UNIDADES.nitrogenio} tone="cyan" compact />
            <Metric icon={<Droplets className="h-4 w-4 text-warn" />} label="Bio-óleo" value={fmt(valores.biooleo, 2)} unit={UNIDADES.biooleo} tone="warn" compact />
          </div>
        </div>
      </section>

      {/* SUBGROUPS */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* GRUPO 2 */}
        <Card
          tag="Grupo 2"
          title="Fluxo de Nitrogênio"
          icon={<Wind className="h-4 w-4" />}
        >
          <Metric
            icon={<Wind className="h-4 w-4 text-cyan" />}
            label="Nitrogênio"
            value={fmt(valores.nitrogenio, 2)}
            unit={UNIDADES.nitrogenio}
          />
          <Spark data={series.nitrogenio} color="var(--cyan)" />
        </Card>

        {/* GRUPO 3 */}
        <Card
          tag="Grupo 3"
          title="Queima e Segurança"
          icon={<Flame className="h-4 w-4" />}
        >
          <Metric
            icon={<Flame className="h-4 w-4 text-warn" />}
            label="Queima"
            value={fmt(valores.queima, 2)}
            unit={UNIDADES.queima}
          />
          <Spark data={series.queima} color="var(--warn)" />
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
              <AreaChart data={series.volumeGas} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
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
          tag="Grupo 6"
          title="Eficiência Energética e Aquecimento"
          icon={<Zap className="h-4 w-4" />}
          className="md:col-span-2"
        >
          {aquecimentoOnline === false && (
            <div className="flex items-center gap-2 rounded-xl border border-danger/50 bg-danger/10 px-4 py-2.5 text-xs text-danger">
              <AlertTriangle className="h-4 w-4" />
              Sem comunicação com a escrava de aquecimento (últimos valores mostrados)
            </div>
          )}
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
              <LineChart data={series.temperatura} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <YAxis
                  domain={[0, 650]}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                />
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
          tag="Grupo 8"
          title="Subproduto · Bio-óleo"
          icon={<Droplets className="h-4 w-4" />}
        >
          <div className="rounded-xl border border-border bg-background/40 p-4">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">
              Bio-óleo
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-mono text-4xl text-warn">{fmt(valores.biooleo, 2)}</span>
              <span className="text-sm text-muted-foreground">{UNIDADES.biooleo}</span>
            </div>
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series.biooleo} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
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
          {conn === "simulacao" ? "Modo simulação (dados gerados no navegador)" : "Telemetria ao vivo · ESP32 mestra via USB"}
          {lastUpdate &&
            ` · último dado às ${lastUpdate.toLocaleTimeString("pt-BR")}`}
        </span>
        <span className="text-mono">PIRO-RICE · v1.2</span>
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

function SafetyBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <div
      className={`flex items-center justify-between rounded-xl border px-3 py-2.5 transition-colors ${
        active
          ? "border-danger/50 bg-danger/10 text-danger"
          : "border-border bg-background/40 text-muted-foreground"
      }`}
    >
      <span className="flex items-center gap-2 text-xs">
        {active ? (
          <AlertTriangle className="h-4 w-4" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-neon" />
        )}
        {label}
      </span>
      <span className={`text-xs font-bold tracking-widest ${active ? "" : "text-foreground"}`}>
        {active ? "SIM" : "NÃO"}
      </span>
    </div>
  );
}
