/**
 * Feature Flags Configuration
 * 
 * Centralized feature flag management for safe rollout of new features.
 * Feature flags can be toggled without deployment.
 */

/**
 * Feature flag definitions
 */
const FEATURE_FLAGS = {
  // Timeline Recalculation Features
  ENABLE_TIMELINE_RECALCULATION: {
    id: 'ENABLE_TIMELINE_RECALCULATION',
    name: 'Timeline Recalculation',
    description: 'Capture actual start time and recalculate booking timeline when service starts early',
    defaultEnabled: false,
    environments: {
      development: true,
      staging: true,
      production: false,  // Start disabled in production
    },
    dependencies: [],
  },

  ENABLE_RECALCULATED_EXTENSIONS: {
    id: 'ENABLE_RECALCULATED_EXTENSIONS',
    name: 'Extensions from Recalculated Timeline',
    description: 'Calculate booking extensions from recalculated end time instead of scheduled end time',
    defaultEnabled: false,
    environments: {
      development: true,
      staging: true,
      production: false,
    },
    dependencies: ['ENABLE_TIMELINE_RECALCULATION'],
  },

  ENABLE_TIMELINE_UI_INDICATORS: {
    id: 'ENABLE_TIMELINE_UI_INDICATORS',
    name: 'Timeline UI Indicators',
    description: 'Show visual indicators for early starts and recalculated timelines in mobile/web apps',
    defaultEnabled: true,  // Safe to enable UI even if backend is off
    environments: {
      development: true,
      staging: true,
      production: true,
    },
    dependencies: [],
  },
};

/**
 * Get current environment
 */
function getCurrentEnvironment() {
  const env = process.env.NODE_ENV || 'development';
  return env.toLowerCase();
}

/**
 * In-memory feature flag overrides (can be set via API or admin panel)
 * Format: { flag_id: { enabled: boolean, percentage: number } }
 */
let featureFlagOverrides = {};

/**
 * Check if a feature flag is enabled
 * 
 * @param {string} flagId - Feature flag ID
 * @param {Object} context - Optional context for percentage rollout
 * @param {number} context.engagement_id - Engagement ID for consistent hashing
 * @param {number} context.customer_id - Customer ID for consistent hashing
 * @returns {boolean} True if feature is enabled
 */
function isFeatureEnabled(flagId, context = {}) {
  const flag = FEATURE_FLAGS[flagId];
  
  if (!flag) {
    console.warn(`Unknown feature flag: ${flagId}`);
    return false;
  }

  // Check dependencies first
  if (flag.dependencies && flag.dependencies.length > 0) {
    for (const depId of flag.dependencies) {
      if (!isFeatureEnabled(depId, context)) {
        console.log(`Feature ${flagId} disabled because dependency ${depId} is disabled`);
        return false;
      }
    }
  }

  // Check for override
  const override = featureFlagOverrides[flagId];
  if (override !== undefined) {
    if (override.enabled === false) {
      return false;
    }
    
    // Percentage-based rollout
    if (override.percentage !== undefined && override.percentage < 100) {
      return isInPercentage(flagId, context, override.percentage);
    }
    
    return override.enabled;
  }

  // Check environment-specific setting
  const env = getCurrentEnvironment();
  if (flag.environments && flag.environments[env] !== undefined) {
    return flag.environments[env];
  }

  // Fall back to default
  return flag.defaultEnabled;
}

/**
 * Determine if a user/engagement is in the rollout percentage
 * Uses consistent hashing so the same ID always gets the same result
 * 
 * @param {string} flagId - Feature flag ID
 * @param {Object} context - Context with IDs
 * @param {number} percentage - Percentage (0-100)
 * @returns {boolean}
 */
function isInPercentage(flagId, context, percentage) {
  // Use engagement_id or customer_id for consistent hashing
  const id = context.engagement_id || context.customer_id;
  
  if (!id) {
    // No context provided, use random (not ideal for consistency)
    return Math.random() * 100 < percentage;
  }

  // Simple hash: combine flag ID and user/engagement ID
  const hashInput = `${flagId}-${id}`;
  let hash = 0;
  for (let i = 0; i < hashInput.length; i++) {
    hash = ((hash << 5) - hash) + hashInput.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  
  // Convert to percentage (0-100)
  const bucket = Math.abs(hash) % 100;
  return bucket < percentage;
}

/**
 * Set feature flag override (for runtime toggling)
 * 
 * @param {string} flagId - Feature flag ID
 * @param {boolean} enabled - Whether to enable the flag
 * @param {number} percentage - Optional percentage for gradual rollout (0-100)
 */
function setFeatureFlagOverride(flagId, enabled, percentage = 100) {
  if (!FEATURE_FLAGS[flagId]) {
    throw new Error(`Unknown feature flag: ${flagId}`);
  }

  if (percentage < 0 || percentage > 100) {
    throw new Error(`Invalid percentage: ${percentage}. Must be 0-100.`);
  }

  featureFlagOverrides[flagId] = {
    enabled,
    percentage,
  };

  console.log(`Feature flag override set: ${flagId} = ${enabled} (${percentage}%)`);
}

/**
 * Clear feature flag override
 * 
 * @param {string} flagId - Feature flag ID
 */
function clearFeatureFlagOverride(flagId) {
  delete featureFlagOverrides[flagId];
  console.log(`Feature flag override cleared: ${flagId}`);
}

/**
 * Get all feature flags with their current status
 * 
 * @returns {Array} Array of feature flag statuses
 */
function getAllFeatureFlags() {
  const env = getCurrentEnvironment();
  
  return Object.values(FEATURE_FLAGS).map(flag => {
    const override = featureFlagOverrides[flag.id];
    const envEnabled = flag.environments?.[env] ?? flag.defaultEnabled;
    
    return {
      id: flag.id,
      name: flag.name,
      description: flag.description,
      enabled: override?.enabled ?? envEnabled,
      percentage: override?.percentage ?? 100,
      hasOverride: override !== undefined,
      defaultEnabled: flag.defaultEnabled,
      environmentEnabled: envEnabled,
      dependencies: flag.dependencies || [],
    };
  });
}

/**
 * Load feature flag overrides from environment variables
 * Useful for container-based deployments
 * 
 * Format: FEATURE_FLAG_<FLAG_ID>=true|false|percentage
 * Example: FEATURE_FLAG_ENABLE_TIMELINE_RECALCULATION=true
 *          FEATURE_FLAG_ENABLE_TIMELINE_RECALCULATION=50 (50% rollout)
 */
function loadFeatureFlagsFromEnv() {
  Object.keys(FEATURE_FLAGS).forEach(flagId => {
    const envKey = `FEATURE_FLAG_${flagId}`;
    const envValue = process.env[envKey];
    
    if (envValue !== undefined) {
      const value = envValue.toLowerCase();
      
      if (value === 'true' || value === '1') {
        setFeatureFlagOverride(flagId, true, 100);
      } else if (value === 'false' || value === '0') {
        setFeatureFlagOverride(flagId, false, 0);
      } else {
        // Try to parse as percentage
        const percentage = parseInt(value, 10);
        if (!isNaN(percentage) && percentage >= 0 && percentage <= 100) {
          setFeatureFlagOverride(flagId, true, percentage);
        } else {
          console.warn(`Invalid feature flag value for ${envKey}: ${envValue}`);
        }
      }
    }
  });
}

// Load feature flags from environment on module load
loadFeatureFlagsFromEnv();

export {
  FEATURE_FLAGS,
  isFeatureEnabled,
  setFeatureFlagOverride,
  clearFeatureFlagOverride,
  getAllFeatureFlags,
  loadFeatureFlagsFromEnv,
};
