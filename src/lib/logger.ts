export class Logger {
  constructor(private readonly context: string) {}

  log(message: unknown) {
    this.write('INFO', message);
  }

  debug(message: unknown) {
    if (process.env.LOG_LEVEL === 'debug') {
      this.write('DEBUG', message);
    }
  }

  warn(message: unknown) {
    this.write('WARN', message);
  }

  error(message: unknown) {
    this.write('ERROR', message);
  }

  private write(level: string, message: unknown) {
    const text = message instanceof Error ? message.stack || message.message : String(message);
    const line = `[${new Date().toISOString()}] [${level}] [${this.context}] ${text}`;

    if (level === 'ERROR') {
      console.error(line);
      return;
    }

    if (level === 'WARN') {
      console.warn(line);
      return;
    }

    console.log(line);
  }
}
