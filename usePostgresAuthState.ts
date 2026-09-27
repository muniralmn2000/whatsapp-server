import { initAuthCreds, BufferJSON, AuthenticationCreds, SignalDataTypeMap, AuthenticationState } from '@whiskeysockets/baileys';
import { Pool } from 'pg';

export const usePostgresAuthState = async (pool: Pool, sessionId: string): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> => {
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS "WhatsAppSession" (
            "id" TEXT PRIMARY KEY,
            "data" JSONB NOT NULL
        );
    `);

    const readData = async (id: string) => {
        const res = await pool.query('SELECT data FROM "WhatsAppSession" WHERE id = $1', [id]);
        if (res.rows.length > 0) {
            return JSON.parse(JSON.stringify(res.rows[0].data), BufferJSON.reviver);
        }
        return null;
    };

    const writeData = async (data: any, id: string) => {
        const str = JSON.stringify(data, BufferJSON.replacer);
        await pool.query(`
            INSERT INTO "WhatsAppSession" (id, data) 
            VALUES ($1, $2::jsonb) 
            ON CONFLICT (id) DO UPDATE SET data = $2::jsonb
        `, [id, str]);
    };

    const removeData = async (id: string) => {
        await pool.query('DELETE FROM "WhatsAppSession" WHERE id = $1', [id]);
    };

    const creds: AuthenticationCreds = await readData(`${sessionId}-creds`) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type: string, ids: string[]) => {
                    const data: { [key: string]: any } = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${sessionId}-${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = import('@whiskeysockets/baileys').then(m => m.proto.Message.AppStateSyncKeyData.fromObject(value));
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data: any) => {
                    const tasks: Promise<void>[] = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${sessionId}-${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, `${sessionId}-creds`);
        }
    };
};
