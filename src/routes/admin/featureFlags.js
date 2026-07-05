/**
 * Admin API for Feature Flag Management
 * 
 * Provides endpoints for viewing and toggling feature flags at runtime.
 * Should be protected with admin authentication.
 */

import express from 'express';
const router = express.Router();
import {
  getAllFeatureFlags,
  setFeatureFlagOverride,
  clearFeatureFlagOverride,
  isFeatureEnabled,
} from '../../config/featureFlags.js';

/**
 * GET /admin/feature-flags
 * List all feature flags with their current status
 */
router.get('/', async (req, res) => {
  try {
    const flags = getAllFeatureFlags();
    res.json({
      success: true,
      flags,
      environment: process.env.NODE_ENV || 'development',
    });
  } catch (error) {
    console.error('Error fetching feature flags:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch feature flags',
    });
  }
});

/**
 * POST /admin/feature-flags/:flagId/enable
 * Enable a feature flag with optional percentage rollout
 * 
 * Body: { percentage?: number (0-100) }
 */
router.post('/:flagId/enable', async (req, res) => {
  try {
    const { flagId } = req.params;
    const { percentage = 100 } = req.body;

    if (percentage < 0 || percentage > 100) {
      return res.status(400).json({
        success: false,
        error: 'Percentage must be between 0 and 100',
      });
    }

    setFeatureFlagOverride(flagId, true, percentage);

    res.json({
      success: true,
      message: `Feature flag ${flagId} enabled at ${percentage}%`,
      flag: {
        id: flagId,
        enabled: true,
        percentage,
      },
    });
  } catch (error) {
    console.error('Error enabling feature flag:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to enable feature flag',
    });
  }
});

/**
 * POST /admin/feature-flags/:flagId/disable
 * Disable a feature flag
 */
router.post('/:flagId/disable', async (req, res) => {
  try {
    const { flagId } = req.params;

    setFeatureFlagOverride(flagId, false, 0);

    res.json({
      success: true,
      message: `Feature flag ${flagId} disabled`,
      flag: {
        id: flagId,
        enabled: false,
        percentage: 0,
      },
    });
  } catch (error) {
    console.error('Error disabling feature flag:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to disable feature flag',
    });
  }
});

/**
 * POST /admin/feature-flags/:flagId/rollout
 * Gradually increase rollout percentage
 * 
 * Body: { percentage: number (0-100) }
 */
router.post('/:flagId/rollout', async (req, res) => {
  try {
    const { flagId } = req.params;
    const { percentage } = req.body;

    if (percentage === undefined || percentage < 0 || percentage > 100) {
      return res.status(400).json({
        success: false,
        error: 'Valid percentage (0-100) is required',
      });
    }

    setFeatureFlagOverride(flagId, true, percentage);

    res.json({
      success: true,
      message: `Feature flag ${flagId} rolled out to ${percentage}%`,
      flag: {
        id: flagId,
        enabled: true,
        percentage,
      },
    });
  } catch (error) {
    console.error('Error adjusting feature flag rollout:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to adjust rollout',
    });
  }
});

/**
 * DELETE /admin/feature-flags/:flagId/override
 * Clear feature flag override (revert to environment default)
 */
router.delete('/:flagId/override', async (req, res) => {
  try {
    const { flagId } = req.params;

    clearFeatureFlagOverride(flagId);

    res.json({
      success: true,
      message: `Feature flag ${flagId} override cleared (reverted to environment default)`,
    });
  } catch (error) {
    console.error('Error clearing feature flag override:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to clear override',
    });
  }
});

/**
 * GET /admin/feature-flags/:flagId/check
 * Check if a feature is enabled for a specific context
 * 
 * Query: ?engagement_id=123 or ?customer_id=456
 */
router.get('/:flagId/check', async (req, res) => {
  try {
    const { flagId } = req.params;
    const { engagement_id, customer_id } = req.query;

    const context = {};
    if (engagement_id) context.engagement_id = parseInt(engagement_id, 10);
    if (customer_id) context.customer_id = parseInt(customer_id, 10);

    const enabled = isFeatureEnabled(flagId, context);

    res.json({
      success: true,
      flagId,
      enabled,
      context,
    });
  } catch (error) {
    console.error('Error checking feature flag:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to check feature flag',
    });
  }
});

export default router;
