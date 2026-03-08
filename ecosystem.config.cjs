module.exports = {
  apps: [
    {
      name: 'mission-control',
      script: 'node_modules/.bin/next',
      args: 'start -p 4010',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
