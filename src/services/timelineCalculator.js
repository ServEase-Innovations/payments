/**
 * Timeline Calculator Service
 * 
 * Handles booking timeline recalculation when service providers start service
 * before the scheduled time. Preserves booked duration while updating start/end times.
 * 
 * @module services/timelineCalculator
 */

import { logger } from '../utils/logger.js';

/**
 * Captures actual service start time and recalculates timeline
 * 
 * When a service provider starts a service, this function:
 * 1. Records the actual start time
 * 2. Calculates the original booked duration
 * 3. Recalculates end time = actual_start + duration
 * 4. Tracks how early the service started
 * 5. Updates the database atomically
 * 
 * @param {Object} params - Parameters
 * @param {number} params.engagement_id - Engagement ID to recalculate
 * @param {number} params.actual_start_epoch - Unix epoch seconds when service actually started
 * @param {Object} params.client - PostgreSQL transaction client
 * @returns {Promise<Object>} Recalculated timeline data
 * @throws {Error} If validation fails or database update fails
 * 
 * @example
 * const timeline = await captureAndRecalculateTimeline({
 *   engagement_id: 12345,
 *   actual_start_epoch: 1720099800,  // 1:30 PM
 *   client: dbClient
 * });
 * // Returns:
 * // {
 * //   scheduled_start_epoch: 1720101600,  // 2:00 PM (original)
 * //   actual_start_epoch: 1720099800,     // 1:30 PM
 * //   scheduled_end_epoch: 1720105200,    // 3:00 PM (original)
 * //   actual_end_epoch: 1720103400,       // 2:30 PM (recalculated)
 * //   duration_minutes: 60,
 * //   early_start_minutes: 30
 * // }
 */
async function captureAndRecalculateTimeline({
  engagement_id,
  actual_start_epoch,
  client
}) {
  try {
    // 1. Fetch engagement with scheduled timeline
    const engagementResult = await client.query(`
      SELECT 
        engagement_id,
        start_epoch,
        end_epoch,
        duration_minutes,
        actual_start_epoch AS existing_actual_start,
        is_timeline_recalculated
      FROM engagements
      WHERE engagement_id = $1
    `, [engagement_id]);

    if (engagementResult.rows.length === 0) {
      throw new Error(`Engagement ${engagement_id} not found`);
    }

    const engagement = engagementResult.rows[0];

    // 2. Prevent duplicate recalculation
    if (engagement.existing_actual_start && engagement.is_timeline_recalculated) {
      logger.info('Timeline already recalculated, returning existing data', {
        engagement_id,
        existing_actual_start: engagement.existing_actual_start
      });

      return {
        scheduled_start_epoch: engagement.start_epoch,
        actual_start_epoch: engagement.existing_actual_start,
        scheduled_end_epoch: engagement.end_epoch,
        actual_end_epoch: null, // Will fetch from DB if needed
        duration_minutes: engagement.duration_minutes,
        early_start_minutes: Math.round((engagement.start_epoch - engagement.existing_actual_start) / 60),
        already_recalculated: true
      };
    }

    // 3. Calculate duration from original booking
    let duration_minutes = engagement.duration_minutes;
    if (!duration_minutes && engagement.start_epoch && engagement.end_epoch) {
      duration_minutes = Math.round((engagement.end_epoch - engagement.start_epoch) / 60);
      // Ensure reasonable duration (15 minutes to 8 hours)
      duration_minutes = Math.max(15, Math.min(duration_minutes, 480));
    }

    if (!duration_minutes || duration_minutes <= 0) {
      throw new Error(`Invalid duration calculated: ${duration_minutes} minutes`);
    }

    // 4. Validate actual start time
    await validateTimeline({
      scheduled_start: engagement.start_epoch,
      scheduled_end: engagement.end_epoch,
      actual_start: actual_start_epoch,
      duration_minutes,
      engagement_id
    });

    // 5. Calculate new end time
    const actual_end_epoch = actual_start_epoch + (duration_minutes * 60);

    // 6. Calculate early start difference
    const early_start_minutes = Math.round((engagement.start_epoch - actual_start_epoch) / 60);

    logger.info('Timeline recalculation computed', {
      engagement_id,
      scheduled_start: engagement.start_epoch,
      actual_start: actual_start_epoch,
      scheduled_end: engagement.end_epoch,
      actual_end: actual_end_epoch,
      duration_minutes,
      early_start_minutes
    });

    // 7. Update database atomically
    await client.query(`
      UPDATE engagements
      SET 
        actual_start_epoch = $1,
        actual_end_epoch = $2,
        duration_minutes = $3,
        is_timeline_recalculated = true,
        early_start_minutes = $4
      WHERE engagement_id = $5
    `, [
      actual_start_epoch,
      actual_end_epoch,
      duration_minutes,
      early_start_minutes,
      engagement_id
    ]);

    // 8. Log modification event
    await logTimelineModification({
      engagement_id,
      modification_type: 'TIMELINE_RECALCULATED',
      details: {
        scheduled_start_epoch: engagement.start_epoch,
        actual_start_epoch,
        scheduled_end_epoch: engagement.end_epoch,
        actual_end_epoch,
        duration_minutes,
        early_start_minutes
      },
      client
    });

    logger.info('Timeline recalculation completed successfully', {
      engagement_id,
      early_start_minutes
    });

    return {
      scheduled_start_epoch: engagement.start_epoch,
      actual_start_epoch,
      scheduled_end_epoch: engagement.end_epoch,
      actual_end_epoch,
      duration_minutes,
      early_start_minutes
    };

  } catch (error) {
    logger.error('Timeline recalculation failed', {
      engagement_id,
      actual_start_epoch,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}


/**
 * Calculate extension end time from recalculated timeline
 * 
 * When a customer extends a booking, this function calculates the new end time
 * using the recalculated end time as the base (not the originally scheduled end time).
 * 
 * @param {Object} params - Parameters
 * @param {number} params.engagement_id - Engagement ID
 * @param {number} params.extension_minutes - Minutes to extend
 * @param {Object} params.client - PostgreSQL transaction client
 * @returns {Promise<Object>} Extended timeline data
 * @throws {Error} If engagement not found or update fails
 * 
 * @example
 * const extended = await calculateExtension({
 *   engagement_id: 12345,
 *   extension_minutes: 60,
 *   client: dbClient
 * });
 * // If service started at 1:30 PM with recalculated end at 2:30 PM:
 * // Returns:
 * // {
 *   //   previous_end_epoch: 1720103400,  // 2:30 PM (recalculated)
 * //   new_end_epoch: 1720107000,        // 3:30 PM (NOT 4:00 PM!)
 * //   extension_minutes: 60,
 * //   calculation_base: 'recalculated_timeline'
 * // }
 */
async function calculateExtension({
  engagement_id,
  extension_minutes,
  client
}) {
  try {
    // Validate extension duration
    if (!Number.isInteger(extension_minutes) || extension_minutes < 15 || extension_minutes > 480) {
      throw new Error(`Invalid extension duration: ${extension_minutes} minutes. Must be 15-480 minutes.`);
    }

    // Fetch current engagement timeline
    const result = await client.query(`
      SELECT 
        engagement_id,
        start_epoch,
        end_epoch,
        actual_start_epoch,
        actual_end_epoch,
        duration_minutes,
        is_timeline_recalculated,
        task_status
      FROM engagements
      WHERE engagement_id = $1
    `, [engagement_id]);

    if (result.rows.length === 0) {
      throw new Error(`Engagement ${engagement_id} not found`);
    }

    const engagement = result.rows[0];

    // Validate booking is in progress
    if (engagement.task_status !== 'IN_PROGRESS') {
      throw new Error(`Cannot extend booking with status: ${engagement.task_status}. Must be IN_PROGRESS.`);
    }

    // Use recalculated end time if available, otherwise use scheduled end time
    const base_end_epoch = engagement.actual_end_epoch || engagement.end_epoch;
    const calculation_base = engagement.actual_end_epoch ? 'recalculated_timeline' : 'scheduled_timeline';

    if (!base_end_epoch) {
      throw new Error(`No valid end time found for engagement ${engagement_id}`);
    }

    // Calculate new end time
    const new_end_epoch = base_end_epoch + (extension_minutes * 60);

    logger.info('Extension calculation computed', {
      engagement_id,
      previous_end: base_end_epoch,
      new_end: new_end_epoch,
      extension_minutes,
      calculation_base
    });

    // Update database
    await client.query(`
      UPDATE engagements
      SET 
        end_epoch = $1,
        actual_end_epoch = CASE 
          WHEN is_timeline_recalculated THEN $1
          ELSE actual_end_epoch
        END,
        duration_minutes = duration_minutes + $2
      WHERE engagement_id = $3
    `, [new_end_epoch, extension_minutes, engagement_id]);

    // Log extension modification
    await logTimelineModification({
      engagement_id,
      modification_type: 'BOOKING_EXTENDED',
      details: {
        previous_end_epoch: base_end_epoch,
        new_end_epoch,
        extension_minutes,
        calculation_base
      },
      client
    });

    logger.info('Extension applied successfully', {
      engagement_id,
      extension_minutes,
      new_end_epoch
    });

    return {
      previous_end_epoch: base_end_epoch,
      new_end_epoch,
      extension_minutes,
      calculation_base
    };

  } catch (error) {
    logger.error('Extension calculation failed', {
      engagement_id,
      extension_minutes,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Validate timeline for edge cases and data integrity
 * 
 * Checks for:
 * - Future timestamps (with 60s tolerance)
 * - Extreme early starts (> 2 hours)
 * - Starts after scheduled end time
 * - Very old timestamps (> 24 hours in past)
 * - Data quality issues (invalid epochs)
 * 
 * @param {Object} params - Validation parameters
 * @param {number} params.scheduled_start - Scheduled start epoch
 * @param {number} params.scheduled_end - Scheduled end epoch
 * @param {number} params.actual_start - Actual start epoch
 * @param {number} params.duration_minutes - Service duration in minutes
 * @param {number} params.engagement_id - Engagement ID (for logging)
 * @throws {Error} If validation fails critically
 * @returns {Promise<void>}
 */
async function validateTimeline({
  scheduled_start,
  scheduled_end,
  actual_start,
  duration_minutes,
  engagement_id
}) {
  const now = Math.floor(Date.now() / 1000);

  // Rule 0: Validate epoch values are reasonable (year 2000 - 2100)
  const MIN_VALID_EPOCH = 946684800;  // 2000-01-01
  const MAX_VALID_EPOCH = 4102444800; // 2100-01-01
  
  if (actual_start < MIN_VALID_EPOCH || actual_start > MAX_VALID_EPOCH) {
    logger.error('Invalid actual_start_epoch value', {
      engagement_id,
      actual_start,
      alert_type: 'INVALID_EPOCH'
    });
    throw new Error(
      `Invalid actual_start_epoch: ${actual_start}. Must be between ${MIN_VALID_EPOCH} and ${MAX_VALID_EPOCH}`
    );
  }

  if (scheduled_start && (scheduled_start < MIN_VALID_EPOCH || scheduled_start > MAX_VALID_EPOCH)) {
    logger.error('Invalid scheduled_start_epoch value', {
      engagement_id,
      scheduled_start,
      alert_type: 'INVALID_EPOCH'
    });
    throw new Error(
      `Invalid scheduled_start_epoch: ${scheduled_start}. Must be between ${MIN_VALID_EPOCH} and ${MAX_VALID_EPOCH}`
    );
  }

  // Rule 1: Cannot be in the future (with 60s tolerance for clock skew)
  if (actual_start > now + 60) {
    throw new Error(
      `Start time cannot be in the future. actual_start: ${actual_start}, now: ${now}`
    );
  }

  // Rule 2: Warn if more than 2 hours before scheduled start
  if (scheduled_start && actual_start) {
    const early_seconds = scheduled_start - actual_start;
    const early_minutes = Math.round(early_seconds / 60);

    // If early_minutes is negative, service started LATE
    if (early_minutes < 0) {
      const late_minutes = Math.abs(early_minutes);
      logger.warn('Service started LATE (after scheduled time)', {
        engagement_id,
        late_minutes,
        scheduled_start,
        actual_start,
        alert_type: 'LATE_START'
      });
      
      // If extremely late (> 2 hours), this might be a data issue
      if (late_minutes > 120) {
        logger.error('Extremely late start detected - possible data issue', {
          engagement_id,
          late_minutes,
          scheduled_start,
          actual_start,
          alert_type: 'EXTREME_LATE_START'
        });
      }
    } else if (early_seconds > 7200) {  // 2 hours
      logger.warn('Extreme early start detected', {
        engagement_id,
        early_minutes,
        scheduled_start,
        actual_start,
        alert_type: 'EXTREME_EARLY_START'
      });
      // Don't throw - allow but log for manual review
    }
  }

  // Rule 3: Block if starts after scheduled end time
  if (scheduled_end && actual_start > scheduled_end) {
    logger.error('Service cannot start after scheduled end time', {
      engagement_id,
      scheduled_end,
      actual_start,
      alert_type: 'LATE_START_AFTER_END'
    });
    throw new Error(
      `Service cannot start after scheduled end time. actual_start: ${actual_start}, scheduled_end: ${scheduled_end}`
    );
  }

  // Rule 4: Warn if more than 24 hours in the past
  if (now - actual_start > 86400) {  // 24 hours
    logger.warn('Start time is more than 24 hours in the past', {
      engagement_id,
      actual_start,
      now,
      hours_ago: Math.round((now - actual_start) / 3600),
      alert_type: 'OLD_START_TIME'
    });
    // Don't throw - allow but log for manual review
  }

  // Rule 5: Validate duration is reasonable
  if (duration_minutes < 15 || duration_minutes > 480) {
    logger.warn('Unusual duration detected', {
      engagement_id,
      duration_minutes,
      alert_type: 'UNUSUAL_DURATION'
    });
  }
}

/**
 * Get effective timeline for a booking
 * 
 * Returns actual timeline if recalculated, otherwise returns scheduled timeline.
 * Useful for display logic and billing calculations.
 * 
 * @param {Object} engagement - Engagement record from database
 * @returns {Object} Effective timeline
 * 
 * @example
 * const timeline = getEffectiveTimeline(engagement);
 * console.log(timeline.start_epoch);  // Uses actual if available, else scheduled
 */
function getEffectiveTimeline(engagement) {
  if (engagement.is_timeline_recalculated && engagement.actual_start_epoch) {
    return {
      start_epoch: engagement.actual_start_epoch,
      end_epoch: engagement.actual_end_epoch || engagement.end_epoch,
      is_recalculated: true,
      duration_minutes: engagement.duration_minutes,
      early_start_minutes: engagement.early_start_minutes || 0
    };
  }

  // Fallback to scheduled times
  return {
    start_epoch: engagement.start_epoch,
    end_epoch: engagement.end_epoch,
    is_recalculated: false,
    duration_minutes: engagement.duration_minutes || Math.round((engagement.end_epoch - engagement.start_epoch) / 60),
    early_start_minutes: 0
  };
}

/**
 * Log timeline modification to engagement_modifications table
 * 
 * Creates an audit trail for all timeline changes.
 * 
 * @param {Object} params - Log parameters
 * @param {number} params.engagement_id - Engagement ID
 * @param {string} params.modification_type - Type of modification
 * @param {Object} params.details - Modification details (JSON)
 * @param {Object} params.client - PostgreSQL client
 * @returns {Promise<void>}
 */
async function logTimelineModification({
  engagement_id,
  modification_type,
  details,
  client
}) {
  try {
    // Try to insert with details column (new schema)
    await client.query(`
      INSERT INTO engagement_modifications (
        engagement_id,
        modification_type,
        modified_by,
        modified_at,
        details
      ) VALUES ($1, $2, $3, NOW(), $4)
    `, [
      engagement_id,
      modification_type,
      'SYSTEM',
      JSON.stringify(details)
    ]);
  } catch (error) {
    // If details column doesn't exist, try with modified_fields (old schema)
    if (error.message && error.message.includes('column "details" of relation "engagement_modifications" does not exist')) {
      try {
        await client.query(`
          INSERT INTO engagement_modifications (
            engagement_id,
            modification_type,
            modified_by,
            modified_at,
            modified_fields
          ) VALUES ($1, $2, $3, NOW(), $4)
        `, [
          engagement_id,
          modification_type,
          'SYSTEM',
          JSON.stringify(details)
        ]);
        logger.info('Timeline modification logged using modified_fields column', {
          engagement_id,
          modification_type
        });
      } catch (fallbackError) {
        // If both fail, just log but don't fail the main operation
        logger.error('Failed to log timeline modification', {
          engagement_id,
          modification_type,
          error: fallbackError.message
        });
      }
    } else {
      // Log but don't fail the main operation if audit logging fails
      logger.error('Failed to log timeline modification', {
        engagement_id,
        modification_type,
        error: error.message
      });
    }
  }
}

export {
  captureAndRecalculateTimeline,
  calculateExtension,
  validateTimeline,
  getEffectiveTimeline,
  logTimelineModification
};

