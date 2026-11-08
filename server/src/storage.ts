import { AwsClient } from 'aws4fetch'

export type Storage = {
  uploadUrl: (userId: string, sha256: string) => Promise<string>
  downloadUrl: (userId: string, sha256: string) => Promise<string>
  // The stored object's size, or null when nothing has been uploaded under that name.
  size: (userId: string, sha256: string) => Promise<number | null>
  // Every object under the account's prefix, for deleting the account.
  deletePrefix: (userId: string) => Promise<void>
}

export type StorageConfig = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }

const URL_TTL_SECONDS = 15 * 60
const DELETE_CONCURRENCY = 20

// The app moves file bytes straight to and from R2 with short-lived signed URLs; they never pass through
// this server. Keys are per user, so deleting an account removes exactly its prefix.
export function createStorage(config: StorageConfig): Storage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto'
  })
  const objectUrl = (userId: string, sha256: string): URL =>
    new URL(`${config.endpoint}/${config.bucket}/${userId}/${sha256}`)
  const sign = async (method: 'PUT' | 'GET', userId: string, sha256: string): Promise<string> => {
    const url = objectUrl(userId, sha256)
    url.searchParams.set('X-Amz-Expires', String(URL_TTL_SECONDS))
    const signed = await client.sign(new Request(url, { method }), { aws: { signQuery: true } })
    return signed.url
  }
  return {
    uploadUrl: (userId, sha256) => sign('PUT', userId, sha256),
    downloadUrl: (userId, sha256) => sign('GET', userId, sha256),
    size: async (userId, sha256) => {
      const res = await client.fetch(objectUrl(userId, sha256), { method: 'HEAD' })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`R2 HEAD failed: ${res.status}`)
      return Number(res.headers.get('content-length'))
    },
    deletePrefix: async (userId) => {
      const bucket = `${config.endpoint}/${config.bucket}`
      // ListObjectsV2 pages hold up to 1000 keys. Keys are "<uuid>/<sha256>", so no XML escaping to undo.
      for (let token: string | null = null; ; ) {
        const list = new URL(bucket)
        list.searchParams.set('list-type', '2')
        list.searchParams.set('prefix', `${userId}/`)
        if (token) list.searchParams.set('continuation-token', token)
        const res = await client.fetch(list)
        if (!res.ok) throw new Error(`R2 list failed: ${res.status}`)
        const xml = await res.text()
        const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])
        // One at a time, a full 1 GB account would outlast the app's 30-second request timeout.
        for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
          await Promise.all(
            keys.slice(i, i + DELETE_CONCURRENCY).map(async (key) => {
              const del = await client.fetch(`${bucket}/${key}`, { method: 'DELETE' })
              if (!del.ok && del.status !== 404) throw new Error(`R2 delete failed: ${del.status}`)
            })
          )
        }
        token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null
        if (!token) return
      }
    }
  }
}
