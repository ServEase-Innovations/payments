module.exports = {
  apps: [
    {
      name: "payments",
      script: "index.js",
      env: {
        NODE_ENV: "dev"
      }
    },
    {
      name: "serveaso-qa",
      script: "index.js",
      env: {
        NODE_ENV: "qa"
      }
    },
    {
      name: "serveaso-prod",
      script: "index.js",
      env: {
        NODE_ENV: "prod"
      }
    }
  ]
};
