module.exports = {
  apps: [
    {
      name: "cmcc-mahjong",
      cwd: __dirname,
      script: "dist/server/src/index.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",
        REDIS_URL: process.env.REDIS_URL || "redis://127.0.0.1:6379",
      },
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
