/**
 * @fileoverview Utilidades centralizadas para peticiones HTTP con lógica de reintentos.
 */

/**
 * Wrapper de UrlFetchApp.fetch con soporte para reintentos exponenciales (Exponential Backoff).
 * Útil para mitigar errores 429 (Too Many Requests), 502 (Bad Gateway), 503 (Service Unavailable) o 504 (Gateway Timeout).
 * 
 * @param {string} url La URL de la API a consultar.
 * @param {Object} options Opciones de fetch (method, headers, payload, etc). Se fuerza muteHttpExceptions=true internamente.
 * @param {number} maxRetries Número máximo de reintentos (por defecto 3).
 * @param {number} backoffFactor Factor de multiplicación de tiempo de espera (en milisegundos).
 * @returns {GoogleAppsScript.URL_Fetch.HTTPResponse} Respuesta de la última ejecución (exitosa o no).
 */
function fetchWithRetries(url, options, maxRetries = 3, backoffFactor = 1500) {
  // Forzamos muteHttpExceptions para no romper el script en un 500 y poder reintentar
  const safeOptions = { ...options, muteHttpExceptions: true };
  
  let retries = 0;
  let response;

  while (retries <= maxRetries) {
    try {
      response = UrlFetchApp.fetch(url, safeOptions);
      const code = response.getResponseCode();
      
      // Códigos considerados "transitorios" que ameritan reintento:
      // 429: Too Many Requests, 500: Internal Server Error, 502: Bad Gateway, 503: Service Unavailable, 504: Gateway Timeout
      if (code !== 429 && code !== 500 && code !== 502 && code !== 503 && code !== 504) {
        // Es un código definitivo (200 OK, 400 Bad Request, 404 Not Found, 401 Unauthorized), retornamos
        return response;
      }
      
      Logger.log(`[FetchUtils] HTTP ${code} devuelto por ${url.substring(0, 50)}...`);
    } catch (e) {
      // Excepción a nivel de red (ej: DNS error, Socket timeout)
      Logger.log(`[FetchUtils] Excepción de red al contactar ${url.substring(0, 50)}...: ${e.message}`);
    }

    if (retries < maxRetries) {
      // Exponential Backoff: Espera 1.5s, 3s, 6s...
      const sleepMs = backoffFactor * Math.pow(2, retries);
      Logger.log(`[FetchUtils] Reintentando llamada HTTP en ${sleepMs}ms... (Intento ${retries + 1} de ${maxRetries})`);
      Utilities.sleep(sleepMs);
    }
    retries++;
  }

  // Retornamos la respuesta (o nulo si no hubo respuesta) para que el servicio superior decida qué hacer
  return response;
}
