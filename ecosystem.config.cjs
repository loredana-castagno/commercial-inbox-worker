// Configuración de PM2 para el EC2. Es un proceso aparte del CRM: mismo servidor,
// ciclos de deploy distintos. No mezclar con el ecosystem del CRM ni con su
// deploy.sh, que trae sus propios preflight checks y su safe-migrate.js.
//
// PENDIENTE DE CONFIRMAR contra el servidor: la ruta base, el usuario de PM2 y el
// puerto del CRM. Los valores de acá son la propuesta, no algo verificado.
//
// Layout asumido:
//   /home/ec2-user/commercial-inbox-worker/
//   ├── app/                  ← el checkout de git (este repo)
//   ├── data/                 ← el SQLite, FUERA del checkout
//   ├── logs/
//   └── .env                  ← fuera del checkout: sobrevive a un clone limpio
//
// El cwd es el directorio padre, así que dotenv encuentra ese .env y un
// `git clean -xdf` adentro de app/ no se lleva ni la base ni las credenciales.
// Por eso DATABASE_URL en el EC2 va absoluta: file:/home/ec2-user/commercial-inbox-worker/data/triage.db

const BASE = '/home/ec2-user/commercial-inbox-worker';

module.exports = {
  apps: [
    {
      name: 'commercial-inbox-worker',
      cwd: BASE,
      // El entrypoint del worker llega en la Fase 2. Hoy este archivo documenta
      // el layout; todavía no hay proceso que levantar.
      script: 'app/dist/worker.js',
      // Sin --loop el worker hace una corrida y termina con exit(0). PM2 lo ve
      // morir, lo reinicia, y queda corriendo cada pocos segundos en vez de cada
      // POLL_INTERVAL_MINUTES. No falla: hace el trabajo cien veces más seguido
      // de lo previsto, y solo se nota mirando los timestamps de los logs.
      args: '--loop',
      instances: 1,
      // SQLite con una sola base no tolera dos escritores: nunca cluster.
      exec_mode: 'fork',
      autorestart: true,
      // La caja tiene 3.8 GB y el build del CRM llega a usar 3. O sea que el
      // margen para todo lo demás es de unos 800 MB, y este worker se lo comparte
      // con el proceso del CRM y el sistema.
      //
      // Medido en una corrida de 50 mensajes: pico de 178 MB de RSS. Corre bien
      // con el heap limitado a 128, así que 192 deja margen y sigue muy por
      // debajo del default de V8 (~2 GB en esta caja). El techo importa: sin él,
      // bajo presión de memoria V8 prefiere crecer antes que recolectar, y PM2
      // solo se entera cuando ya creció.
      node_args: '--max-old-space-size=192',
      max_memory_restart: '300M',
      // Si arranca y muere en loop (por ejemplo, un preflight que falla por
      // credenciales), que no reintente para siempre en silencio.
      max_restarts: 10,
      min_uptime: '60s',
      restart_delay: 5000,
      out_file: `${BASE}/logs/out.log`,
      error_file: `${BASE}/logs/error.log`,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
