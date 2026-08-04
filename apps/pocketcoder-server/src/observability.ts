export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface LogRecord extends LogFields {
	timestamp: string;
	level: LogLevel;
	event: string;
}

export interface StructuredLogger {
	debug(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
}

export type LogSink = (record: LogRecord) => void;

export function createStructuredLogger(
	sink: LogSink = (record) => console.log(JSON.stringify(record)),
	now: () => Date = () => new Date(),
): StructuredLogger {
	const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
		sink({ timestamp: now().toISOString(), level, event, ...fields });
	};
	return {
		debug: (event, fields) => write("debug", event, fields),
		info: (event, fields) => write("info", event, fields),
		warn: (event, fields) => write("warn", event, fields),
		error: (event, fields) => write("error", event, fields),
	};
}
