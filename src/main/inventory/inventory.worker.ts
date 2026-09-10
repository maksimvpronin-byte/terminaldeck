import { parentPort, workerData } from 'node:worker_threads'
import { readInventory, type InventoryRead } from './readInventory'

parentPort!.postMessage(readInventory(workerData as InventoryRead))
