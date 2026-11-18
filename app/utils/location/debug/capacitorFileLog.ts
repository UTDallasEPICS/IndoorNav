// Writes the location debug log (debugLog.ts) to a JSON-lines file on the phone, via @capacitor/filesystem.
// The file stays in the app's own storage; a developer copies it off with Xcode / adb (see README.md). Nothing is
// uploaded anywhere (C02).
//
//   iOS:     <app data container>/Documents/location-logs/location-<time>.jsonl
//   Android: /sdcard/Android/data/<app id>/files/location-logs/location-<time>.jsonl (app-specific, no permission)

import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { JsonlDebugLog, type JsonlDebugLogOptions } from './debugLog'

export const DEBUG_LOG_FOLDER = 'location-logs'

export interface FileDebugLog {
  log: JsonlDebugLog
  /** Path inside the app's storage, e.g. "location-logs/location-2026-11-17T21-04-05.jsonl" */
  path: string
}

/**
 * Starts a new log file named after the current time and returns a log that appends to it. Synchronous, so it can
 * be created before the location service: records logged while the file is still being created wait for it.
 * If the file can't be created, every write fails and the lines are counted in `log.failedLines`.
 */
export function createFileDebugLog(options: Partial<JsonlDebugLogOptions> = {}): FileDebugLog {
  const directory = Capacitor.getPlatform() === 'android' ? Directory.External : Directory.Documents
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
  const path = `${DEBUG_LOG_FOLDER}/location-${stamp}.jsonl`
  const created = Filesystem.writeFile({ path, directory, data: '', encoding: Encoding.UTF8, recursive: true })
  created.catch(() => {}) // reported through the writes below, not as an unhandled rejection
  const log = new JsonlDebugLog(async (text) => {
    await created
    await Filesystem.appendFile({ path, directory, data: text, encoding: Encoding.UTF8 })
  }, options)
  return { log, path }
}
