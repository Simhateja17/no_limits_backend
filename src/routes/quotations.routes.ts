import { Router } from 'express';
import {
  getQuotations,
  getQuotationById,
  createQuotation,
  updateQuotation,
  updateQuotationStatus,
  deleteQuotation,
} from '../controllers/quotations.controller.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = Router();

// All quotation routes require authentication
router.use(authenticate);

// GET /api/quotations - Get all quotations (filtered by role)
router.get('/', getQuotations);

// GET /api/quotations/:id - Get quotation by ID
router.get('/:id', getQuotationById);

// POST /api/quotations - Create new quotation (admin only)
router.post('/', requireAdmin, createQuotation);

// PUT /api/quotations/:id - Update quotation (admin only)
router.put('/:id', requireAdmin, updateQuotation);

// POST /api/quotations/:id/status - Update quotation status (client can accept/reject)
router.post('/:id/status', updateQuotationStatus);

// DELETE /api/quotations/:id - Delete quotation (admin only)
router.delete('/:id', requireAdmin, deleteQuotation);

export default router;
