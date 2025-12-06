module.exports = {
  apps: [
    {
      name: "serveaso-dev",
      script: "src/index.js",
      env_dev: {
        NODE_ENV: "development"
      },
      name: "serveaso-qa",
      script: "src/index.js",
      env_qa: {
        NODE_ENV: "qa"
      },
      name: "serveaso-prod",
      script: "src/index.js",
      env_prod: {
        NODE_ENV: "production"
      }
    }
  ]
}
