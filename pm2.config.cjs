module.exports = {
  apps: [
    {
      name: "openagent",
      script: "src/index.ts",
      interpreter: "bun",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
      },
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
  ],
};
