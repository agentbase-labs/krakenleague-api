import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db.js';
import { requireAuth } from '../lib/auth-hook.js';
import { deriveAddress, derivationPathFor } from '../lib/wallet.js';
import { CHAINS } from '../lib/chains.js';

const SignupInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});
const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/auth/signup', async (req, reply) => {
    const parsed = SignupInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const db = getDb();
    const existing = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email.toLowerCase()))
      .limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: 'email_taken' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [user] = await db
      .insert(schema.users)
      .values({ email: email.toLowerCase(), passwordHash })
      .returning();

    // Provision 4 agent wallets (same EVM address, one row per chain).
    const userIndex = user!.userIndex;
    const address = deriveAddress(userIndex);
    const path = derivationPathFor(userIndex);
    await db.insert(schema.agentWallets).values(
      CHAINS.map((chain) => ({
        userId: user!.id,
        chain,
        address,
        derivationPath: path,
      })),
    );

    const token = await reply.jwtSign(
      { sub: user!.id, email: user!.email },
      { expiresIn: '7d' },
    );
    return reply.send({
      token,
      user: {
        id: user!.id,
        email: user!.email,
        createdAt: user!.createdAt.toISOString(),
      },
    });
  });

  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const db = getDb();
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, parsed.data.email.toLowerCase()))
      .limit(1);
    if (!user) return reply.code(401).send({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });
    const token = await reply.jwtSign({ sub: user.id, email: user.email }, { expiresIn: '7d' });
    return reply.send({
      token,
      user: { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() },
    });
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const db = getDb();
    const [u] = await db
      .select({ id: schema.users.id, email: schema.users.email, createdAt: schema.users.createdAt, verifiedEoa: schema.users.verifiedEoa })
      .from(schema.users)
      .where(eq(schema.users.id, req.user.sub))
      .limit(1);
    if (!u) return reply.code(404).send({ error: 'not_found' });
    return {
      id: u.id,
      email: u.email,
      createdAt: u.createdAt.toISOString(),
      verifiedEoa: u.verifiedEoa,
    };
  });
}
