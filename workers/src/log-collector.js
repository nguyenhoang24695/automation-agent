/**
 * Collects and formats logs from a container execution.
 * Each log line gets a timestamp for tracking.
 */
export class LogCollector {
  /**
   * @param {string} sessionId - Task session identifier
   */
  constructor(sessionId) {
    this.sessionId = sessionId;
    /** @type {string[]} */
    this.logs = [];
    this.startTime = Date.now();
  }

  /**
   * Add a log line with timestamp.
   * @param {string} line
   */
  add(line) {
    const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
    this.logs.push(`[${timestamp}] ${line}`);
  }

  /**
   * Generate a Telegram-friendly summary message.
   *
   * @param {string} status - 'done' or 'error'
   * @returns {string} Formatted Markdown message
   */
  getSummary(status) {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const icon = status === 'done' ? '✅' : '❌';

    // Build header
    const header = [
      `${icon} *Task ${status.toUpperCase()}*`,
      `Session: \`${this.sessionId}\``,
      `Duration: ${duration}s`,
      `Lines: ${this.logs.length}`,
      '─'.repeat(30),
    ].join('\n');

    // Last 50 lines, max 3000 chars (Telegram limit = 4096, leave room for header)
    const recentLogs = this.logs.slice(-50).join('\n');
    let logText = recentLogs.length > 3000
      ? '...(truncated)...\n' + recentLogs.slice(-3000)
      : recentLogs;

    return `${header}\n\`\`\`\n${logText}\n\`\`\``;
  }
}
