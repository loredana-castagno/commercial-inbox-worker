# commercial-inbox-worker

Worker en TypeScript que **clasifica y procesa automáticamente las respuestas a
campañas de email frío** que llegan a un inbox de Gmail, reemplazando un proceso
manual de triage. El clasificador LLM decide *solo* la categoría; las reglas de
negocio (a qué lista va cada mail, qué label se aplica, cuándo frena) son código
determinístico y testeado.

> **Nota:** este es un extracto público y sanitizado de un proyecto real. Se
> quitaron los datos de la empresa, direcciones de terceros, IDs de cuentas
> externas y la documentación operativa interna. Los nombres, dominios y IDs que
> quedan son ficticios.

## Idea general

Un mail entra al inbox → se parsea (limpiando la cita del hilo) → un prefiltro
determinístico descarta lo que no corresponde → el clasificador LLM le asigna una
categoría y extrae entidades → un handler puro traduce esa categoría a una lista de
acciones → el executor las ejecuta contra Gmail y las integraciones externas.

```
Gmail ─▶ parse ─▶ prefiltro ─▶ clasificador (LLM) ─▶ handler (puro) ─▶ executor ─▶ efectos
                  (código)      categoría+entidades   acciones          Gmail / Snov / CRM
```

## Decisiones de diseño

- **El LLM clasifica; el negocio lo decide el código.** El prompt devuelve
  categoría y entidades con structured output. A qué lista va un lead o qué label
  se aplica no vive en el prompt: es código determinístico en `src/execute/`. Así
  las reglas son testeables sin llamar al modelo.
- **Handlers puros + executor.** Cada handler de categoría es una función pura que
  devuelve una lista de acciones. La ejecución (con sus efectos) la hace el
  executor. Los handlers se testean sin mocks.
- **Seguridad por defecto cerrada.** Dos flags de escritura independientes, ambos
  apagados por default: uno para Gmail (labels/archivado, reversible), otro para
  las integraciones externas (Snov/CRM, no reversible). Con los dos en `false` el
  worker clasifica y registra, pero no escribe nada afuera. Las combinaciones
  incoherentes fallan al bootear, no en medio de un batch.
- **Nunca se borran mails** (se sacan del inbox quitando el label, nunca con
  delete) y los mails calientes **nunca se responden solos**: como máximo se genera
  un draft para revisión humana.
- **Idempotente.** El id de mensaje de Gmail es la clave primaria del registro de
  triage; el mismo rango se puede reprocesar sin duplicar acciones ni llamadas a
  APIs externas.
- **Integraciones aisladas.** Cada API externa (Gmail, Snov, CRM, Anthropic) vive
  en su módulo con retry y timeout; nada de `fetch` suelto en la lógica de negocio.
- **Se escribe en Windows, corre en Linux.** Rutas siempre con `path.join`, imports
  case-sensitive, y las diferencias de `.env` entre máquinas documentadas — los dos
  errores que pasan desapercibidos en desarrollo y rompen en producción.

## Stack

TypeScript + Node (ESM) · Prisma + SQLite (WAL) · `googleapis` para Gmail ·
SDK de Anthropic con structured outputs · PM2 para el deploy.

## Setup

```bash
npm install
cp .env.example .env   # completar credenciales
npm run db:migrate
npm run config:check   # valida el env completo y la conexión a la base
```

```bash
npm run worker            # una corrida y termina
npm run worker -- --loop  # ciclo cada POLL_INTERVAL_MINUTES
```

## Scripts principales

| Script | Qué hace |
|---|---|
| `npm test` | Suite de tests: parser, stripping de citado, retry, handlers, executor, clientes |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | `prisma generate` + compila a `dist/` |
| `npm run evals` | corre el clasificador sobre el dataset anotado y reporta precisión por categoría |
| `npm run config:check` | valida el env y la conexión a la base |

## Layout

```
src/
├── classify/    prompt y clasificador LLM (structured output)
├── execute/     prefiltros, handlers puros y executor (reglas de negocio)
├── gmail/       cliente, parser y stripping de citado
├── snov/        enriquecimiento y escritura contra Snov
├── crm/         cliente HTTP del CRM (solo por HTTP, nunca acceso directo)
└── evals/       harness de evaluación sobre el dataset anotado
```

## Tests

La lógica de negocio (prefiltros, handlers, executor, parsing) está cubierta por
tests unitarios que no dependen de red ni de mocks pesados, porque los handlers son
funciones puras. Las integraciones externas se testean contra sus clientes con
retry/timeout aislados.
