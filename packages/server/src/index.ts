import { loadConfig } from './config.js';
import { AuditLogger } from './audit-logger.js';
import { PtyManager } from './pty-manager.js';
import { SessionManager } from './session-manager.js';
import { PermissionController } from './permission.js';
import { WsServer } from './ws-server.js';

const config = loadConfig();

const auditLogger = new AuditLogger(config);
const ptyManager = new PtyManager(config);
const sessionManager = new SessionManager(config, ptyManager);
const permissions = new PermissionController();
const wsServer = new WsServer(sessionManager, ptyManager, permissions, auditLogger, config);

console.log(`
╔══════════════════════════════════════════╗
║       PWA Terminal Session Manager       ║
╠══════════════════════════════════════════╣
║  Port:  ${String(config.port).padEnd(32)}║
║  Host:  ${config.host.padEnd(32)}║
║  Token: ********${''.padEnd(24)}║
╚══════════════════════════════════════════╝
`);

if (!config.host.startsWith('127.') && config.host !== 'localhost' && config.host !== '::1') {
  console.warn('[warning] Server is binding to a non-loopback address without TLS.');
  console.warn('[warning] Use a reverse proxy (Caddy/Nginx) with TLS for production use.');
}

function shutdown(): void {
  console.log('\n[shutdown] Graceful shutdown initiated...');
  wsServer.close();
  sessionManager.killAll();
  ptyManager.killAll();
  console.log('[shutdown] All resources cleaned up. Exiting.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
