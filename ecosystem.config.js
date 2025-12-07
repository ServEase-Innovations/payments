module.exports = {
  apps: [
    {
      name: "payments",
      script: "index.js",

      env: {
        NODE_ENV: "development"
      },
      env_qa: {
        NODE_ENV: "qa"
      },
      env_production: {
        NODE_ENV: "production"
      }
    }
  ]
};
