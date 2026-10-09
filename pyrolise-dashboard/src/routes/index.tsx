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
  Wifi,
  WifiOff,
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

// Endereço do servidor WebSocket do ESP32 (modo Access Point).
// Pode ser trocado sem mexer no código criando um arquivo .env com VITE_ESP32_WS=ws://...
const ESP32_WS_URL: string = import.meta.env.VITE_ESP32_WS ?? "ws://192.168.4.1:81";
const RECONNECT_MS = 2000;

// Unidades de cada sensor. Confirmem com o pessoal de cada escrava e ajustem aqui.
const UNIDADES = {
  temperatura: "°C",
  aquecimento: "%",
  nitrogenio: "L/min",
  volumeGas: "L",
  biooleo: "ml",
  queima: "",
};

// Sensores que o ESP32 mestre envia (mesmos nomes do campo "sensor" no JSON)
type SensorName = keyof typeof UNIDADES;
const SENSORES = Object.keys(UNIDADES) as SensorName[];

type Point = { t: number; v: number };
const MAX_POINTS = 40;

function pushSeries(series: Point[], v: number, t: number): Point[] {
  const next = [...series, { t, v: Number(v.toFixed(2)) }];
  return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
}

function fmt(n: number | null, d = 1) {
  return n === null ? "—" : n.toFixed(d);
}

type ConnStatus = "conectando" | "conectado" | "desconectado";

function Dashboard() {
  const [running, setRunning] = useState(false);
  const [setpoint, setSetpoint] = useState(420);
  const [now, setNow] = useState(new Date());
  const [elapsed, setElapsed] = useState(0);
  const [conn, setConn] = useState<ConnStatus>("conectando");
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // telemetria recebida do ESP32 (null = ainda não chegou nenhum valor)
  const [valores, setValores] = useState<Record<SensorName, number | null>>({
    temperatura: null,
    aquecimento: null,
    nitrogenio: null,
    volumeGas: null,
    biooleo: null,
    queima: null,
  });
  const [series, setSeries] = useState<Record<SensorName, Point[]>>({
    temperatura: [],
    aquecimento: [],
    nitrogenio: [],
    volumeGas: [],
    biooleo: [],
    queima: [],
  });

  const socketRef = useRef<WebSocket | null>(null);
  const startRef = useRef(Date.now());
  // último setpoint confirmado pelo ESP32 (para não reenviar o que veio dele)
  const espSetpointRef = useRef<number | null>(null);

  // relógio
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // tempo de processo
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // conexão WebSocket com o ESP32, com reconexão automática
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      setConn("conectando");
      socket = new WebSocket(ESP32_WS_URL);
      socketRef.current = socket;

      socket.onopen = () => setConn("conectado");

      socket.onmessage = (evento) => {
        let pacote: { sensor?: string; valor?: unknown };
        try {
          pacote = JSON.parse(evento.data);
        } catch {
          console.warn("Mensagem inválida do ESP32:", evento.data);
          return;
        }
        const valor = Number(pacote.valor);
        if (!Number.isFinite(valor)) return;

        // confirmações de comando enviadas pelo ESP32
        if (pacote.sensor === "estado") {
          setRunning(valor === 1);
          return;
        }
        if (pacote.sensor === "setpoint") {
          espSetpointRef.current = valor;
          setSetpoint(valor);
          return;
        }

        if (!SENSORES.includes(pacote.sensor as SensorName)) return;
        const nome = pacote.sensor as SensorName;
        const t = Math.round((Date.now() - startRef.current) / 1000);
        setValores((v) => ({ ...v, [nome]: valor }));
        setSeries((s) => ({ ...s, [nome]: pushSeries(s[nome], valor, t) }));
        setLastUpdate(new Date());
      };

      socket.onclose = () => {
        socketRef.current = null;
        setConn("desconectado");
        if (!closed) retry = setTimeout(connect, RECONNECT_MS);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, []);

  const enviar = (msg: object) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  // O estado só muda na tela quando o ESP32 confirma ({"sensor":"estado",...})
  const toggleRunning = () => enviar({ cmd: running ? "desligar" : "ligar" });

  // envia o setpoint 300 ms depois que o usuário para de mexer no slider
  // (só depois que o ESP32 informou o setpoint atual dele, para não sobrescrevê-lo ao abrir a página)
  useEffect(() => {
    if (espSetpointRef.current === null || setpoint === espSetpointRef.current) return;
    const id = setTimeout(() => enviar({ cmd: "setpoint", valor: setpoint }), 300);
    return () => clearTimeout(id);
  }, [setpoint]);

  const online = conn === "conectado";
  const temp = valores.temperatura;

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
          <StatusBadge running={running} />
          <div className="rounded-xl border border-border bg-background/60 px-4 py-2">
            <div className="text-mono text-2xl leading-none text-neon">{clock}</div>
            <div className="mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
              {dateStr}
            </div>
          </div>
        </div>
      </header>

      {/* CONTROL PANEL */}
      <section className="mb-6 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-2xl panel-grad border border-border p-5">
          <SectionTitle icon={<Power className="h-4 w-4" />} label="Painel de Controle Central" />
          <div className="mt-4 grid gap-5 md:grid-cols-[auto_1fr] md:items-center">
            <button
              onClick={toggleRunning}
              disabled={!online}
              title={online ? undefined : "Sem conexão com o ESP32"}
              className={`group relative h-32 w-32 rounded-full border-2 transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                running
                  ? "border-neon glow-neon"
                  : "border-border hover:border-muted-foreground"
              }`}
            >
              <div
                className={`absolute inset-2 rounded-full ${
                  running ? "bg-neon/15" : "bg-secondary"
                } grid place-items-center transition-colors`}
              >
                <Power
                  className={`h-12 w-12 ${running ? "text-neon" : "text-muted-foreground"}`}
                />
              </div>
              <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 text-xs font-semibold tracking-widest text-muted-foreground">
                {running ? "DESLIGAR" : "LIGAR"}
              </span>
            </button>

            <div className="mt-6 md:mt-0">
              <div className="flex items-baseline justify-between">
                <label className="text-xs uppercase tracking-widest text-muted-foreground">
                  Setpoint · Temperatura do Reator
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
                disabled={!online}
                onChange={(e) => setSetpoint(Number(e.target.value))}
                className="mt-3 w-full accent-[color:var(--neon)] disabled:opacity-50"
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
                    disabled={!online}
                    className="rounded-lg border border-border bg-background/40 py-2 text-mono hover:border-neon hover:text-neon transition disabled:opacity-50 disabled:hover:border-border disabled:hover:text-inherit"
                  >
                    {p}°C
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl panel-grad border border-border p-5">
          <SectionTitle icon={<Activity className="h-4 w-4" />} label="Telemetria Crítica" />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Metric icon={<Thermometer className="h-4 w-4 text-neon" />} label="Temp. Reator" value={fmt(temp, 0)} unit={UNIDADES.temperatura} tone="neon" compact />
            <Metric icon={<Zap className="h-4 w-4 text-warn" />} label="Aquecimento" value={fmt(valores.aquecimento, 1)} unit={UNIDADES.aquecimento} tone="warn" compact />
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
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              icon={<Zap className="h-4 w-4 text-warn" />}
              label="Aquecimento"
              value={fmt(valores.aquecimento, 1)}
              unit={UNIDADES.aquecimento}
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
              label="Tempo Processo"
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
          Telemetria ao vivo · ESP32 em {ESP32_WS_URL}
          {lastUpdate &&
            ` · último dado às ${lastUpdate.toLocaleTimeString("pt-BR")}`}
        </span>
        <span className="text-mono">PIRO-RICE · v1.1</span>
      </footer>
    </main>
  );
}

/* ----------------- subcomponents ----------------- */

function ConnBadge({ status }: { status: ConnStatus }) {
  const online = status === "conectado";
  return (
    <div
      className={`flex items-center gap-2 rounded-xl border px-4 py-2 ${
        online
          ? "border-cyan/40 bg-cyan/10 text-cyan"
          : "border-warn/40 bg-warn/10 text-warn"
      }`}
    >
      {online ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
      <span className="text-xs font-bold tracking-[0.18em]">
        {status === "conectado"
          ? "ESP32 ONLINE"
          : status === "conectando"
            ? "CONECTANDO..."
            : "ESP32 OFFLINE"}
      </span>
    </div>
  );
}


function StatusBadge({ running }: { running: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-xl border px-4 py-2 ${
        running
          ? "border-neon/40 bg-neon/10 text-neon glow-neon"
          : "border-danger/40 bg-danger/10 text-danger glow-danger"
      }`}
    >
      <span
        className={`relative flex h-2.5 w-2.5 ${running ? "" : ""}`}
      >
        <span
          className={`absolute inset-0 rounded-full ${
            running ? "bg-neon" : "bg-danger"
          } animate-ping opacity-75`}
        />
        <span
          className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
            running ? "bg-neon" : "bg-danger"
          }`}
        />
      </span>
      <span className="text-xs font-bold tracking-[0.18em]">
        {running ? "OPERANDO" : "DESLIGADO"}
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
