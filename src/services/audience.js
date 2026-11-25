import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export const audienceSchema = z.object({
  text: z.string().trim().min(1, 'Adicione os números ou selecione um arquivo.').max(900000),
  format: z.enum(['csv', 'txt', 'paste']),
  countryCode: z.enum(['', '55']).default(''),
});

// Uma única interpretação no servidor para prévia, importação e campanha.
export function parseAudience(input, db) {
  const { text, format, countryCode } = audienceSchema.parse(input);
  let rows;
  if (format === 'csv') {
    try {
      const header = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
      rows = parse(text, {
        bom: true,
        trim: true,
        skip_empty_lines: true,
        delimiter: header.includes(';') ? ';' : ',',
        columns: (columns) => columns.map((column) => column.trim().toLowerCase()),
      }).map((row, index) => ({
        name: row.nome || row.name || '',
        phone: row.telefone || row.phone || row.numero || row.whatsapp || '',
        email: row.email || '',
        line: index + 2,
      }));
    } catch {
      throw Object.assign(
        new Error('CSV inválido. Use o cabeçalho nome,telefone,email ou apenas telefone.'),
        { status: 400 },
      );
    }
  } else {
    rows = text
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      .filter((row) => row.line.trim())
      .map(({ line, index }) => {
        const parts = line.split(';').map((part) => part.trim());
        return parts.length === 1
          ? { name: '', phone: parts[0], email: '', line: index + 1 }
          : {
              name: parts[0],
              phone: parts[1],
              email: parts[2] || '',
              line: index + 1,
              extra: parts.length > 3,
            };
      });
  }
  if (!rows.length || rows.length > 5000) {
    throw Object.assign(new Error('Adicione de 1 a 5.000 contatos por vez.'), { status: 400 });
  }
  const contacts = [],
    errors = [],
    seen = new Set();
  let duplicates = 0,
    blocked = 0,
    existingCount = 0;
  for (const row of rows) {
    let phone = row.phone.replace(/[\s()+.\-]/g, '');
    if (countryCode === '55' && !row.phone.trim().startsWith('+') && /^(\d{10}|\d{11})$/.test(phone))
      phone = `55${phone}`;
    const name = row.name.trim() || `Contato ${phone}`;
    const email = row.email.trim();
    if (
      row.extra ||
      !/^[1-9]\d{9,14}$/.test(phone) ||
      name.length > 120 ||
      (email && !z.email().safeParse(email).success)
    ) {
      errors.push({
        line: row.line,
        message: 'Confira telefone com DDI/DDD, nome (até 120 caracteres) e e-mail.',
      });
      continue;
    }
    if (seen.has(phone)) {
      duplicates++;
      continue;
    }
    seen.add(phone);
    const existing = db.prepare('SELECT name,opted_in FROM contacts WHERE phone=?').get(phone);
    if (existing) existingCount++;
    if (existing && !existing.opted_in) blocked++;
    contacts.push({
      name: existing?.name || name,
      phone,
      email,
      blocked: Boolean(existing && !existing.opted_in),
    });
  }
  return {
    contacts,
    total: rows.length,
    unique: contacts.length,
    eligible: contacts.length - blocked,
    duplicates,
    blocked,
    existing: existingCount,
    errors,
  };
}

export function requireValidAudience(result) {
  if (result.errors.length)
    throw Object.assign(
      new Error(
        `Corrija ${result.errors.length} linha(s) inválida(s). Primeira: linha ${result.errors[0].line}. Nenhum contato foi salvo.`,
      ),
      { status: 400 },
    );
  if (!result.contacts.length)
    throw Object.assign(new Error('Nenhum número válido encontrado.'), { status: 400 });
}

// Chamada dentro da transação do importador ou da criação de campanha.
export function saveAudience(db, listId, contacts) {
  let created = 0,
    linked = 0;
  for (const row of contacts) {
    const existing = db.prepare('SELECT id FROM contacts WHERE phone=?').get(row.phone);
    const contactId = existing?.id || randomUUID();
    if (!existing) {
      db.prepare('INSERT INTO contacts VALUES (?,?,?,?,?,?)').run(
        contactId,
        row.name,
        row.phone,
        row.email,
        1,
        new Date().toISOString(),
      );
      created++;
    }
    linked += db.prepare('INSERT OR IGNORE INTO list_contacts VALUES (?,?)').run(listId, contactId).changes;
  }
  return { created, linked };
}
