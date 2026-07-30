import type { Worker } from "bullmq";

let _workers: Worker[] = [];

export function setWorkers(workers: Worker[]): void {
  _workers = workers;
}

export function getWorkers(): Worker[] {
  return _workers;
}
