import { onRequestGet as __api_stocks_js_onRequestGet } from "/home/claude/portfolio-tracker-pwa/functions/api/stocks.js"

export const routes = [
    {
      routePath: "/api/stocks",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_stocks_js_onRequestGet],
    },
  ]