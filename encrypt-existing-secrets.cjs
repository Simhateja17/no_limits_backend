require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Encryption service (same as backend)
function encrypt(text) {
  const algorithm = 'aes-256-gcm';
  const encryptionKey = process.env.ENCRYPTION_KEY || 'your-32-character-secret-key!!';
  const key = Buffer.from(encryptionKey.padEnd(32, '0').slice(0, 32));
  
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

async function encryptExistingSecrets() {
  try {
    console.log('🔐 Encrypting existing JTL client secrets...\n');

    // Get all JTL configs
    const jtlConfigs = await prisma.jtlConfig.findMany({
      select: {
        id: true,
        clientId_fk: true,
        clientId: true,
        clientSecret: true,
      }
    });

    console.log(`Found ${jtlConfigs.length} JTL config(s)\n`);

    for (const config of jtlConfigs) {
      // Check if already encrypted (contains colons in the expected format)
      const parts = config.clientSecret.split(':');
      if (parts.length === 3 && parts[0].length === 32 && parts[1].length === 32) {
        console.log(`✓ Client ${config.clientId_fk}: Already encrypted, skipping`);
        continue;
      }

      // Encrypt the plain text secret
      const encryptedSecret = encrypt(config.clientSecret);
      
      await prisma.jtlConfig.update({
        where: { id: config.id },
        data: { clientSecret: encryptedSecret }
      });

      console.log(`✅ Client ${config.clientId_fk}: Encrypted client secret`);
    }

    console.log('\n✨ All JTL client secrets encrypted successfully!');

  } catch (error) {
    console.error('❌ Error encrypting secrets:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

encryptExistingSecrets();
