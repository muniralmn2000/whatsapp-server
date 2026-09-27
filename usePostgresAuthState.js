"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePostgresAuthState = void 0;
const baileys_1 = require("@whiskeysockets/baileys");
const pg_1 = require("pg");
const usePostgresAuthState = async (pool, sessionId) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS "WhatsAppSession" (
            "id" TEXT PRIMARY KEY,
            "data" JSONB NOT NULL
        );
    `);
    const readData = async (id) => {
        const res = await pool.query('SELECT data FROM "WhatsAppSession" WHERE id = $1', [id]);
        if (res.rows.length > 0) {
            return JSON.parse(JSON.stringify(res.rows[0].data), baileys_1.BufferJSON.reviver);
        }
        return null;
    };
    const writeData = async (data, id) => {
        const str = JSON.stringify(data, baileys_1.BufferJSON.replacer);
        await pool.query(`
            INSERT INTO "WhatsAppSession" (id, data) 
            VALUES ($1, $2::jsonb) 
            ON CONFLICT (id) DO UPDATE SET data = $2::jsonb
        `, [id, str]);
    };
    const removeData = async (id) => {
        await pool.query('DELETE FROM "WhatsAppSession" WHERE id = $1', [id]);
    };
    const creds = await readData(`${sessionId}-creds`) || (0, baileys_1.initAuthCreds)();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${sessionId}-${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = import('@whiskeysockets/baileys').then(m => m.proto.Message.AppStateSyncKeyData.fromObject(value));
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${sessionId}-${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            }
                            else {
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
exports.usePostgresAuthState = usePostgresAuthState;
//# sourceMappingURL=usePostgresAuthState.js.map