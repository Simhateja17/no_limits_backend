import { Router } from 'express';
import { 
  getClients, 
  getClientById, 
  getClientStats,
  createClient,
  updateClient,
  deleteClient
} from '../controllers/clients.controller.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = Router();

// All client routes require authentication and admin role
router.use(authenticate);
router.use(requireAdmin);

// GET /api/clients - Get all clients
router.get('/', getClients);

// GET /api/clients/stats - Get client statistics
router.get('/stats', getClientStats);

// POST /api/clients - Create new client
router.post('/', createClient);

// GET /api/clients/:id - Get client by ID
router.get('/:id', getClientById);

// PUT /api/clients/:id - Update client
router.put('/:id', updateClient);

// DELETE /api/clients/:id - Delete client
router.delete('/:id', deleteClient);

export default router;
