module.exports = {
  apps: [{
    name: 'hexseal-relayer',
    script: './index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 2000,
    env: { NODE_ENV: 'production' },
  }],
};
