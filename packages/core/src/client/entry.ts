import { RamjetContext, RamjetInterface } from "@/shared/index";
import { RAMJETCLIENT } from "@/symbols";
import { RamjetClient } from "@client/index";
import { RamjetConfig } from "@/types";

export const iswindow = "window" in globalThis && window instanceof Window;
export const isworker = "WorkerGlobalScope" in globalThis;
export const issw = "ServiceWorkerGlobalScope" in globalThis;
export const isdedicated = "DedicatedWorkerGlobalScope" in globalThis;
export const isshared = "SharedWorkerGlobalScope" in globalThis;
