import { _Map } from "./snapshot";

export class BoundedLru<K, V> {
	private readonly map = new _Map<K, V>();

	constructor(private readonly max: number) {
		if (!(max >= 1)) throw new RangeError("BoundedLru max must be >= 1");
	}

	get(key: K): V | undefined {
		const value = this.map.get(key);
		if (value === undefined) return undefined;
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		} else if (this.map.size >= this.max) {
			this.map.delete(this.map.keys().next().value as K);
		}
		this.map.set(key, value);
	}

	get size(): number {
		return this.map.size;
	}

	clear(): void {
		this.map.clear();
	}
}
