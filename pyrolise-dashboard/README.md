# Supervisório · Pirólise de Biomassa (Casca de Arroz)

Dashboard industrial em modo escuro (cinza grafite + verde neon/azul) para monitorar e
controlar um reator de pirólise. Toda a telemetria é **simulada** no navegador com um
`setInterval` de 1 segundo — temperatura, pressão, vazões, bio-óleo, corrente e tensão.

## Como rodar

Pré-requisito: [Bun](https://bun.sh) instalado (ou troque `bun` por `npm` nos comandos).

```bash
bun install
bun run dev
```

Depois abra `http://localhost:8080`.

Para gerar a versão de produção:

```bash
bun run build
bun run preview
```

## Estrutura

| Arquivo | O que faz |
| --- | --- |
| `src/routes/index.tsx` | **Todo o dashboard**: estado, loop de simulação (`setInterval`), cards dos Grupos 2, 3, 4, 6 e 8, gráficos Recharts e componentes visuais (`Card`, `Metric`, `Spark`, `SafetyBadge`, `StatusBadge`). |
| `src/routes/__root.tsx` | Shell HTML, `<head>` (título, descrição, fontes Inter + JetBrains Mono), telas de 404 e erro. |
| `src/styles.css` | Tema dark: tokens de cor (`--neon`, `--cyan`, `--warn`, `--danger`, `--panel`), utilitários `panel-grad`, `glow-neon`, `glow-danger`, `text-mono`. |
| `src/router.tsx` | Cria o router e o `QueryClient`. |
| `src/routeTree.gen.ts` | Árvore de rotas gerada automaticamente — não edite. |
| `src/start.ts`, `src/server.ts` | Bootstrap do TanStack Start (SSR). |
| `src/lib/` | Utilitários (relatório de erros, página de erro, `cn`). |
| `src/components/ui/` | Componentes shadcn prontos no projeto (a tela principal não precisa deles). |

## Lógica da simulação

- **Temperatura do reator** persegue o setpoint com inércia térmica:
  `prev + (alvo - prev) * 0.08 + ruído`, voltando a ~25 °C quando desligado.
- **Gás** acima acima de 280 °C e **Chama** acima de 350 °C.
- **Gás pirolítico** só escoa acima de 300 °C; **bio-óleo** só acima de 380 °C.
- **Bio-óleo acumulado** soma a taxa (g/s) a cada segundo e vira gráfico de área.
- Pressão, vazão de N₂, corrente e tensão oscilam com `Math.sin` + ruído aleatório.

## Controles

- Botão **LIGAR / DESLIGAR** circular.
- **Slider de setpoint** de 0 a 600 °C, com atalhos de 300 / 420 / 550 °C.
- Relógio em tempo real e cronômetro de tempo de processo (`HH:MM:SS`).

## Tecnologias

React 19 · TanStack Start/Router v1 · Vite 7 · Tailwind CSS v4 · Recharts · lucide-react.
