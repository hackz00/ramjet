const SMALL_BODY_LIMIT = 64 * 1024;
const PROBE_MS = 20;

export async function prepareBody(
	body: BodyInit,
): Promise<{ body: BodyInit; length?: number }> {
	if (typeof body === "string")
		return { body, length: new TextEncoder().encode(body).byteLength };
	if (body instanceof Blob) return { body, length: body.size };
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
		return { body, length: body.byteLength };
	if (body instanceof URLSearchParams) {
		const text = body.toString();
		return { body, length: new TextEncoder().encode(text).byteLength };
	}
	if (!(body instanceof ReadableStream)) return { body };

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
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
				return { body: complete, length: bytes };
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

	return {
		body: new ReadableStream<Uint8Array>({
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
		}),
	};
}
