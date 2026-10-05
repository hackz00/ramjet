const SMALL_BODY_LIMIT = 64 * 1024;
const PROBE_MS = 20;

type Chunk = Uint8Array;

export async function prepareUpload<T>(
	body: T,
): Promise<T | Uint8Array | ReadableStream<Chunk>> {
	if (!(body instanceof ReadableStream)) return body;

	const reader = (body as ReadableStream<Chunk>).getReader();
	const chunks: Chunk[] = [];
	let bytes = 0;
	let pending: Promise<ReadableStreamReadResult<Chunk>> | undefined;
	const deadline = performance.now() + PROBE_MS;
	try {
		while (bytes <= SMALL_BODY_LIMIT) {
			pending = reader.read();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const next = await Promise.race([
				pending,
				new Promise<null>((resolve) => {
					timer = setTimeout(
						() => resolve(null),
						Math.max(0, deadline - performance.now()),
					);
				}),
			]).finally(() => clearTimeout(timer));
			if (next === null) break;
			pending = undefined;
			if (next.done) {
				reader.releaseLock();
				const complete = new Uint8Array(bytes);
				let offset = 0;
				for (const chunk of chunks) {
					complete.set(chunk, offset);
					offset += chunk.byteLength;
				}
				return complete;
			}
			if (!(next.value instanceof Uint8Array))
				throw new TypeError(
					"Request body stream must contain Uint8Array chunks",
				);
			chunks.push(next.value);
			bytes += next.value.byteLength;
			if (performance.now() >= deadline) break;
		}
	} catch (error) {
		void reader.cancel(error).catch(() => {});
		throw error;
	}

	return new ReadableStream<Chunk>({
		async pull(controller) {
			if (chunks.length) return controller.enqueue(chunks.shift()!);
			const next = await (pending ?? reader.read());
			pending = undefined;
			if (next.done) {
				reader.releaseLock();
				controller.close();
			} else controller.enqueue(next.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export function needsZeroContentLength(method: string, body: unknown): boolean {
	if (!BODY_METHODS.has(method.toUpperCase())) return false;
	if (body === null || body === undefined) return true;
	if (typeof body === "string") return body.length === 0;
	if (body instanceof ArrayBuffer) return body.byteLength === 0;
	if (ArrayBuffer.isView(body)) return body.byteLength === 0;
	if (body instanceof Blob) return body.size === 0;
	return false;
}
