const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// enable logging
// const prisma = new PrismaClient({
//     log: ['query', 'info', 'warn', 'error'],
// });

exports.prisma = prisma;