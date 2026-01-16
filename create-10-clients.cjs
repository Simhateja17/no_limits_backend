require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function createTenClients() {
  try {
    console.log('🌱 Creating 30 new clients (skips existing emails)...\n');

    const password = await bcrypt.hash('password123', 10);

    const clients = [
      { email: 'anna.mueller@example.com', name: 'Anna Müller', companyName: 'Müller Naturkosmetik', phone: '+49 30 12345678', address: 'Friedrichstraße 123, 10117 Berlin' },
      { email: 'thomas.schmidt@example.com', name: 'Thomas Schmidt', companyName: 'Schmidt Sport & Fitness', phone: '+49 89 98765432', address: 'Maximilianstraße 45, 80539 München' },
      { email: 'lisa.weber@example.com', name: 'Lisa Weber', companyName: 'Weber Home & Living', phone: '+49 40 55667788', address: 'Mönckebergstraße 78, 20095 Hamburg' },
      { email: 'michael.fischer@example.com', name: 'Michael Fischer', companyName: 'Fischer Elektronik & Technik', phone: '+49 221 33445566', address: 'Hohe Straße 90, 50667 Köln' },
      { email: 'julia.wagner@example.com', name: 'Julia Wagner', companyName: 'Wagner Gourmet & Delikatessen', phone: '+49 711 22334455', address: 'Königstraße 112, 70173 Stuttgart' },
      { email: 'robert.hoffmann@example.com', name: 'Robert Hoffmann', companyName: 'Hoffmann Bürobedarf & Schreibwaren', phone: '+49 69 77889900', address: 'Zeil 56, 60313 Frankfurt am Main' },
      { email: 'sabrina.koch@example.com', name: 'Sabrina Koch', companyName: 'Koch Baby & Kindermode', phone: '+49 511 88776655', address: 'Georgstraße 34, 30159 Hannover' },
      { email: 'peter.becker@example.com', name: 'Peter Becker', companyName: 'Becker Uhren & Schmuck', phone: '+49 228 66554433', address: 'Poststraße 12, 53111 Bonn' },
      { email: 'claudia.schulz@example.com', name: 'Claudia Schulz', companyName: 'Schulz Wein & Feinkost', phone: '+49 351 44332211', address: 'Prager Straße 88, 01069 Dresden' },
      { email: 'maria.krueger@example.com', name: 'Maria Krüger', companyName: 'Krüger Naturprodukte', phone: '+49 30 99887766', address: 'Alt-Moabit 12, 10559 Berlin' },

      { email: 'alexander.klein@example.com', name: 'Alexander Klein', companyName: 'Klein Technik', phone: '+49 40 11223344', address: 'Lange Reihe 5, 20359 Hamburg' },
      { email: 'sandra.meyer@example.com', name: 'Sandra Meyer', companyName: 'Meyer Textiles', phone: '+49 89 55443322', address: 'Leopoldstraße 10, 80802 München' },
      { email: 'christian.neumann@example.com', name: 'Christian Neumann', companyName: 'Neumann Autos', phone: '+49 221 66554433', address: 'Kaiserstraße 2, 50667 Köln' },
      { email: 'katrin.schneider@example.com', name: 'Katrin Schneider', companyName: 'Schneider Floristik', phone: '+49 711 99887766', address: 'Tübinger Straße 20, 70178 Stuttgart' },
      { email: 'uwe.krause@example.com', name: 'Uwe Krause', companyName: 'Krause Bau & Renovierung', phone: '+49 69 44332211', address: 'Friedensstraße 7, 60313 Frankfurt am Main' },
      { email: 'ina.bauer@example.com', name: 'Ina Bauer', companyName: 'Bauer Biohof', phone: '+49 511 33445566', address: 'Hildesheimer Str. 45, 30169 Hannover' },
      { email: 'oliver.schroeder@example.com', name: 'Oliver Schröder', companyName: 'Schröder IT-Services', phone: '+49 228 77665544', address: 'Markt 6, 53111 Bonn' },
      { email: 'monika.fuchs@example.com', name: 'Monika Fuchs', companyName: 'Fuchs Boutique', phone: '+49 351 55667788', address: 'Wilsdruffer Straße 21, 01067 Dresden' },
      { email: 'daniel.lange@example.com', name: 'Daniel Lange', companyName: 'Lange Logistics', phone: '+49 30 66778899', address: 'Bückerstraße 4, 10559 Berlin' },
      { email: 'eva.freitag@example.com', name: 'Eva Freitag', companyName: 'Freitag Elektro', phone: '+49 40 33221100', address: 'Steindamm 33, 20099 Hamburg' },

      { email: 'tom.hartmann@example.com', name: 'Tom Hartmann', companyName: 'Hartmann Consulting', phone: '+49 30 22113344', address: 'Kurzstraße 2, 10115 Berlin' },
      { email: 'sabine.keller@example.com', name: 'Sabine Keller', companyName: 'Keller Optik', phone: '+49 89 22112233', address: 'Hohenzollernstraße 25, 80796 München' },
      { email: 'marcus.weiss@example.com', name: 'Marcus Weiss', companyName: 'Weiss Audio', phone: '+49 40 22113355', address: 'Alstertor 7, 20095 Hamburg' },
      { email: 'helga.ritter@example.com', name: 'Helga Ritter', companyName: 'Ritter Möbel', phone: '+49 221 77881122', address: 'Domstraße 8, 50668 Köln' },
      { email: 'nina.lorenz@example.com', name: 'Nina Lorenz', companyName: 'Lorenz Fashion', phone: '+49 711 99880011', address: 'Bismarckstraße 3, 70176 Stuttgart' },
      { email: 'florian.behrens@example.com', name: 'Florian Behrens', companyName: 'Behrens Transporte', phone: '+49 69 88776655', address: 'Römerstraße 11, 60311 Frankfurt am Main' },
      { email: 'stefan.schulze@example.com', name: 'Stefan Schulze', companyName: 'Schulze Technik', phone: '+49 511 66003322', address: 'Hannoversche Straße 12, 30159 Hannover' },
      { email: 'jana.pohl@example.com', name: 'Jana Pohl', companyName: 'Pohl Papeterie', phone: '+49 228 66557788', address: 'Bonngasse 4, 53113 Bonn' },
      { email: 'tobias.hahn@example.com', name: 'Tobias Hahn', companyName: 'Hahn Medien', phone: '+49 351 55221100', address: 'Prießnitzstraße 6, 01069 Dresden' },
      { email: 'karin.zimmermann@example.com', name: 'Karin Zimmermann', companyName: 'Zimmermann Pharma', phone: '+49 30 99884477', address: 'Lehrter Straße 22, 10557 Berlin' },
    ];

    let created = 0;
    for (const c of clients) {
      const existing = await prisma.user.findFirst({ where: { email: c.email } });
      if (existing) {
        console.log(`⚠️ Skipping existing user: ${c.email}`);
        continue;
      }

      const user = await prisma.user.create({
        data: {
          email: c.email,
          password,
          name: c.name,
          role: 'CLIENT',
          phone: c.phone,
          isActive: true,
          client: {
            create: {
              name: c.name,
              companyName: c.companyName,
              email: c.email,
              phone: c.phone,
              address: c.address,
              isActive: true,
            },
          },
        },
      });

      console.log(`✅ Created user: ${user.email} (${c.companyName})`);
      created++;
    }

    console.log(`\n✨ Done. Created ${created} new clients. Password for each: password123`);
  } catch (err) {
    console.error('❌ Error creating clients:', err);
    throw err;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

createTenClients();
