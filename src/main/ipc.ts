import { BrowserWindow, ipcMain, shell } from 'electron'
import type Database from 'better-sqlite3'
import type { IpcChannels, SearchServiceId } from '@shared/types'
import { getFile, getFiles } from './db/repo/files'
import { listMarkCategories } from './db/repo/markCategories'
import { createMark, deleteMark, listMarks, updateMark } from './db/repo/marks'
import {
  addModel,
  createProvider,
  deleteModel,
  deleteProvider,
  getProvider,
  getProviderApiKeyEnc,
  listModels,
  listProviders,
  updateModel,
  updateProvider
} from './db/repo/providers'
import { conversationUsage, findMessage, listConversationMessages } from './db/repo/messages'
import { getNoteContent, listNotes, listRevisions, restoreRevision, saveNote } from './db/repo/notes'
import { createProject, deleteProject, listProjects, updateProject } from './db/repo/projects'
import { search } from './db/repo/search'
import { getSearchServiceKeysEnc, listSearchServices, setSearchServiceKey } from './db/repo/searchServices'
import {
  deleteSession,
  getGlobalPrompt,
  listSessions,
  moveSession,
  renameSession,
  setGlobalPrompt
} from './db/repo/sessions'
import { getFontSize, getOpenAtLogin, setFontSize, setMiniShortcut, setOpenAtLogin } from './db/repo/settings'
import type { FileStore } from './files/store'
import { createChat } from './llm/chat'
import { listRemoteModels } from './llm/listModels'
import { conversationTranscript, createOrganizer } from './llm/organize'
import type { Connection } from './llm/types'
import { appendAiDraft, clipToNote, replaceWithAiRewrite, transferNoteText } from './notes'
import { exaSearch, tavilySearch, type SearchKeys } from './search/services'
import { createWebTools } from './search/webTools'
import { applyOpenAtLogin, type Mini } from './miniWindow'
import { decryptSecret, encryptSecret } from './secrets'
import type { SyncService } from './sync/service'
import type { Updater } from './updater'

// Every request from the window may have written something; sync checks whether anything is waiting to
// go up, so the repo code never has to tell it (D-067).
let afterRequest: () => void = () => {}

function handle<K extends keyof IpcChannels>(
  channel: K,
  handler: (...args: Parameters<IpcChannels[K]>) => ReturnType<IpcChannels[K]>
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await handler(...(args as Parameters<IpcChannels[K]>))
    } finally {
      afterRequest()
    }
  })
}

function encryptOptional(apiKey: string): Buffer | null {
  return apiKey === '' ? null : encryptSecret(apiKey)
}

function connectionFor(db: Database.Database, providerId: string): Connection {
  const provider = getProvider(db, providerId)
  const apiKeyEnc = getProviderApiKeyEnc(db, providerId)
  return {
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: apiKeyEnc ? decryptSecret(apiKeyEnc) : ''
  }
}

function searchKeys(db: Database.Database): SearchKeys {
  return Object.fromEntries(getSearchServiceKeysEnc(db).map((s) => [s.id, decryptSecret(s.apiKeyEnc)]))
}

async function testSearchService(id: SearchServiceId, key: string): Promise<void> {
  const signal = AbortSignal.timeout(20_000)
  const run = id === 'tavily' ? tavilySearch : exaSearch
  await run(fetch, key, 'Hush', null, signal)
}

export function registerIpc(
  db: Database.Database,
  files: FileStore,
  sync: SyncService,
  mini: Mini,
  updater: Updater,
  openMain: (sessionId: string) => void,
  onFlushed: () => void
): void {
  afterRequest = sync.changed
  const chat = createChat({
    db,
    readFile: files.read,
    ensureFile: files.ensure,
    connection: (providerId) => connectionFor(db, providerId),
    webTools: () => {
      const keys = searchKeys(db)
      return Object.keys(keys).length > 0 ? createWebTools(keys) : null
    },
    emit: (messageId, event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('chat:event', { messageId, event })
      }
      // A reply only goes up once it's finished.
      if (event.type === 'done' || event.type === 'error') sync.changed()
    },
    sessionUpdated: (session) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('session:updated', session)
    }
  })
  const organizer = createOrganizer({
    db,
    connection: (providerId) => connectionFor(db, providerId),
    emit: (jobId, event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('organize:event', { jobId, event })
      }
    }
  })

  handle('markCategories:list', () => listMarkCategories(db))
  handle('marks:list', (sessionId) => listMarks(db, sessionId))
  handle('marks:create', (input) => createMark(db, input))
  handle('marks:update', (id, patch) => updateMark(db, id, patch))
  handle('marks:delete', (id) => deleteMark(db, id))

  handle('providers:list', () => listProviders(db))
  handle('providers:create', ({ apiKey, ...rest }) =>
    createProvider(db, { ...rest, apiKeyEnc: encryptOptional(apiKey) })
  )
  handle('providers:update', (id, { apiKey, ...rest }) =>
    updateProvider(db, id, {
      ...rest,
      apiKeyEnc: apiKey === undefined ? undefined : encryptOptional(apiKey)
    })
  )
  handle('providers:delete', (id) => deleteProvider(db, id))
  handle('providers:fetchModels', (id) => listRemoteModels(connectionFor(db, id)))

  handle('models:list', () => listModels(db))
  handle('models:add', (providerId, input) => addModel(db, providerId, input))
  handle('models:update', (id, patch) => updateModel(db, id, patch))
  handle('models:delete', (id) => deleteModel(db, id))

  handle('projects:list', () => listProjects(db))
  handle('projects:create', (name) => createProject(db, name))
  handle('projects:update', (id, patch) => updateProject(db, id, patch))
  handle('projects:delete', (id) => deleteProject(db, id))
  handle('sessions:list', () => listSessions(db))
  handle('sessions:rename', (id, title) => renameSession(db, id, title))
  handle('sessions:move', (id, projectId) => moveSession(db, id, projectId))
  handle('sessions:delete', (id) => deleteSession(db, id))
  handle('sessions:usage', (id) => conversationUsage(db, id))
  handle('sessions:transcript', (id) => conversationTranscript(db, id))
  handle('globalPrompt:get', () => ({ prompt: getGlobalPrompt(db) }))
  handle('globalPrompt:set', (prompt) => setGlobalPrompt(db, prompt))
  handle('fontSize:get', () => getFontSize(db))
  handle('fontSize:set', (size) => {
    setFontSize(db, size)
    // The window that changed it zooms itself; the others (the mini window) follow.
    for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomFactor(getFontSize(db) / 16)
  })
  handle('messages:list', (sessionId) => chat.withLiveReplies(listConversationMessages(db, sessionId)))
  handle('messages:get', (id) => findMessage(db, id))
  handle('notes:list', () => listNotes(db))
  handle('notes:get', (target) => getNoteContent(db, target))
  handle('notes:save', (target, content) => saveNote(db, target, content))
  handle('notes:revisions', (target) => listRevisions(db, target))
  handle('notes:restore', (id) => restoreRevision(db, id))
  handle('notes:transfer', (input) => transferNoteText(db, input))
  handle('notes:clip', (clip, markdown, comment) => clipToNote(db, clip, markdown, comment))
  handle('notes:aiAppend', (target, markdown) => appendAiDraft(db, target, markdown))
  handle('notes:aiRewrite', (target, base, content) => replaceWithAiRewrite(db, target, base, content))
  handle('search:query', (query) => search(db, query))
  handle('app:flushed', onFlushed)
  handle('chat:send', async (input) => {
    await chat.fetchFiles(input)
    const result = chat.send(input)
    // A session started in one window (e.g. the mini window) shows up in the others' lists.
    if (!input.sessionId) {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('session:updated', result.session)
    }
    return result
  })
  handle('chat:regenerate', async (input) => {
    await chat.fetchFiles(input)
    return chat.regenerate(input)
  })
  handle('chat:stop', (messageId) => chat.stop(messageId))
  handle('organize:start', (input) => organizer.start(input))
  handle('organize:stop', (jobId) => organizer.stop(jobId))

  handle('searchServices:list', () => listSearchServices(db))
  handle('searchServices:setKey', (id, apiKey) => {
    setSearchServiceKey(db, id, encryptOptional(apiKey))
    return listSearchServices(db)
  })
  handle('searchServices:test', async (id) => {
    const key = searchKeys(db)[id]
    if (!key) throw new Error('还没有填写 key')
    await testSearchService(id, key)
  })
  // Cited links come from web pages, so only plain web addresses may reach the system browser.
  handle('links:open', async (url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error(`Not a web link: ${url}`)
    await shell.openExternal(url)
  })

  handle('account:sendCode', (email) => sync.sendCode(email))
  handle('account:login', (email, code) => sync.login(email, code))
  handle('account:logout', () => sync.logout())
  handle('account:delete', () => sync.deleteAccount())
  handle('account:openPrivacy', () => shell.openExternal(sync.privacyUrl))
  handle('sync:status', () => sync.status())
  handle('sync:now', () => sync.check())
  handle('sync:markSeen', () => sync.markSeen())
  handle('updater:status', () => updater.status())
  handle('updater:check', () => void updater.check())
  handle('updater:download', () => void updater.download())
  handle('updater:install', () => updater.install())

  handle('files:add', (input) => files.add(input))
  handle('files:get', (ids) => getFiles(db, ids))
  handle('files:ensure', (id) => files.ensure(getFile(db, id)))
  handle('files:open', async (id) => {
    const file = getFile(db, id)
    await files.ensure(file)
    const error = await shell.openPath(files.pathOf(file))
    if (error) throw new Error(error)
  })

  // Windows' own title-bar buttons. They act on the sender's window, which `handle` doesn't pass, and write
  // nothing, so they skip its sync check.
  const windowOf = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)
  ipcMain.handle('window:minimize', (event) => windowOf(event)?.minimize())
  ipcMain.handle('window:toggleMaximize', (event) => {
    const win = windowOf(event)
    if (win?.isMaximized()) win.unmaximize()
    else win?.maximize()
  })
  // close() goes through the window's close handler, so pending note edits are flushed first.
  ipcMain.handle('window:close', (event) => windowOf(event)?.close())

  handle('mini:hide', () => mini.hide())
  handle('mini:resize', (height) => mini.resize(height))
  handle('mini:openInMain', (sessionId) => {
    mini.hide()
    openMain(sessionId)
  })
  handle('miniSettings:get', () => {
    const { accelerator, registered } = mini.shortcut()
    return { shortcut: accelerator, registered, openAtLogin: getOpenAtLogin(db) }
  })
  handle('miniSettings:setShortcut', (accelerator) => {
    const ok = mini.setShortcut(accelerator)
    if (ok) setMiniShortcut(db, accelerator)
    return ok
  })
  handle('miniSettings:recording', (recording) => mini.pauseShortcut(recording))
  handle('miniSettings:setOpenAtLogin', (on) => {
    setOpenAtLogin(db, on)
    applyOpenAtLogin(on)
  })
}
