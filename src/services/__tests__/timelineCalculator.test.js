/**
 * Unit Tests for Timeline Calculator Service
 * 
 * Tests timeline recalculation logic for early service starts and extensions.
 */

const {
  captureAndRecalculateTimeline,
  calculateExtension,
  validateTimeline,
  getEffectiveTimeline,
} = require('../timelineCalculator');

// Mock logger to suppress console output during tests
jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('Timeline Calculator Service', () => {
  let mockClient;

  beforeEach(() => {
    // Mock PostgreSQL client
    mockClient = {
      query: jest.fn(),
    };
    jest.clearAllMocks();
  });

  describe('captureAndRecalculateTimeline', () => {
    const baseEngagement = {
      engagement_id: 12345,
      start_epoch: 1720101600,  // 2:00 PM
      end_epoch: 1720105200,    // 3:00 PM
      duration_minutes: 60,
      existing_actual_start: null,
      is_timeline_recalculated: false,
    };

    test('calculates end time from actual start correctly', async () => {
      const actual_start = 1720099800; // 1:30 PM (30 min early)

      mockClient.query
        .mockResolvedValueOnce({ rows: [baseEngagement] })  // SELECT engagement
        .mockResolvedValueOnce({ rows: [] })                // UPDATE engagement
        .mockResolvedValueOnce({ rows: [] });               // INSERT modification log

      const result = await captureAndRecalculateTimeline({
        engagement_id: 12345,
        actual_start_epoch: actual_start,
        client: mockClient,
      });

      expect(result).toMatchObject({
        scheduled_start_epoch: 1720101600,
        actual_start_epoch: 1720099800,
        scheduled_end_epoch: 1720105200,
        actual_end_epoch: 1720103400,  // 2:30 PM (1:30 + 60 min)
        duration_minutes: 60,
        early_start_minutes: 30,
      });

      // Verify UPDATE query
      const updateCall = mockClient.query.mock.calls[1];
      expect(updateCall[0]).toContain('UPDATE engagements');
      expect(updateCall[1]).toEqual([
        1720099800,  // actual_start_epoch
        1720103400,  // actual_end_epoch
        60,          // duration_minutes
        30,          // early_start_minutes
        12345,       // engagement_id
      ]);
    });

    test('calculates early start minutes correctly', async () => {
      const actual_start = 1720095600; // 12:30 PM (90 min early)

      mockClient.query
        .mockResolvedValueOnce({ rows: [baseEngagement] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await captureAndRecalculateTimeline({
        engagement_id: 12345,
        actual_start_epoch: actual_start,
        client: mockClient,
      });

      expect(result.early_start_minutes).toBe(90);
      expect(result.actual_end_epoch).toBe(actual_start + 3600); // +60 min
    });

    test('calculates duration from epoch when duration_minutes is null', async () => {
      const engagementNoDuration = {
        ...baseEngagement,
        duration_minutes: null,
      };

      mockClient.query
        .mockResolvedValueOnce({ rows: [engagementNoDuration] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await captureAndRecalculateTimeline({
        engagement_id: 12345,
        actual_start_epoch: 1720099800,
        client: mockClient,
      });

      expect(result.duration_minutes).toBe(60); // (end - start) / 60
    });

    test('prevents duplicate recalculation', async () => {
      const alreadyRecalculated = {
        ...baseEngagement,
        existing_actual_start: 1720099800,
        is_timeline_recalculated: true,
      };

      mockClient.query.mockResolvedValueOnce({ rows: [alreadyRecalculated] });

      const result = await captureAndRecalculateTimeline({
        engagement_id: 12345,
        actual_start_epoch: 1720099800,
        client: mockClient,
      });

      expect(result.already_recalculated).toBe(true);
      expect(mockClient.query).toHaveBeenCalledTimes(1); // Only SELECT, no UPDATE
    });

    test('throws error when engagement not found', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        captureAndRecalculateTimeline({
          engagement_id: 99999,
          actual_start_epoch: 1720099800,
          client: mockClient,
        })
      ).rejects.toThrow('Engagement 99999 not found');
    });

    test('throws error when duration is invalid', async () => {
      const invalidEngagement = {
        ...baseEngagement,
        duration_minutes: null,
        start_epoch: null,
        end_epoch: null,
      };

      mockClient.query.mockResolvedValueOnce({ rows: [invalidEngagement] });

      await expect(
        captureAndRecalculateTimeline({
          engagement_id: 12345,
          actual_start_epoch: 1720099800,
          client: mockClient,
        })
      ).rejects.toThrow('Invalid duration');
    });

    test('handles service starting on time (early_start_minutes = 0)', async () => {
      const actual_start = 1720101600; // Exactly 2:00 PM

      mockClient.query
        .mockResolvedValueOnce({ rows: [baseEngagement] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await captureAndRecalculateTimeline({
        engagement_id: 12345,
        actual_start_epoch: actual_start,
        client: mockClient,
      });

      expect(result.early_start_minutes).toBe(0);
      expect(result.actual_start_epoch).toBe(result.scheduled_start_epoch);
    });
  });

  describe('calculateExtension', () => {
    const baseEngagement = {
      engagement_id: 12345,
      start_epoch: 1720101600,
      end_epoch: 1720105200,
      actual_start_epoch: 1720099800,
      actual_end_epoch: 1720103400,  // 2:30 PM (recalculated)
      duration_minutes: 60,
      is_timeline_recalculated: true,
      task_status: 'IN_PROGRESS',
    };

    test('extension uses recalculated end time as base', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [baseEngagement] })  // SELECT
        .mockResolvedValueOnce({ rows: [] })                // UPDATE
        .mockResolvedValueOnce({ rows: [] });               // INSERT log

      const result = await calculateExtension({
        engagement_id: 12345,
        extension_minutes: 60,
        client: mockClient,
      });

      expect(result).toMatchObject({
        previous_end_epoch: 1720103400,  // 2:30 PM (recalculated)
        new_end_epoch: 1720107000,       // 3:30 PM (NOT 4:00 PM!)
        extension_minutes: 60,
        calculation_base: 'recalculated_timeline',
      });
    });

    test('falls back to scheduled end when no recalculation', async () => {
      const noRecalculation = {
        ...baseEngagement,
        actual_start_epoch: null,
        actual_end_epoch: null,
        is_timeline_recalculated: false,
      };

      mockClient.query
        .mockResolvedValueOnce({ rows: [noRecalculation] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await calculateExtension({
        engagement_id: 12345,
        extension_minutes: 60,
        client: mockClient,
      });

      expect(result.previous_end_epoch).toBe(1720105200); // 3:00 PM (scheduled)
      expect(result.new_end_epoch).toBe(1720108800);      // 4:00 PM
      expect(result.calculation_base).toBe('scheduled_timeline');
    });

    test('handles multiple extensions correctly', async () => {
      // First extension already applied
      const extendedOnce = {
        ...baseEngagement,
        actual_end_epoch: 1720107000,  // Already extended to 3:30 PM
        duration_minutes: 120,          // 60 + 60
      };

      mockClient.query
        .mockResolvedValueOnce({ rows: [extendedOnce] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await calculateExtension({
        engagement_id: 12345,
        extension_minutes: 30,
        client: mockClient,
      });

      expect(result.new_end_epoch).toBe(1720108800); // 4:00 PM (3:30 + 30 min)
    });

    test('rejects extension when booking not IN_PROGRESS', async () => {
      const completedBooking = {
        ...baseEngagement,
        task_status: 'COMPLETED',
      };

      mockClient.query.mockResolvedValueOnce({ rows: [completedBooking] });

      await expect(
        calculateExtension({
          engagement_id: 12345,
          extension_minutes: 60,
          client: mockClient,
        })
      ).rejects.toThrow('Cannot extend booking with status: COMPLETED');
    });

    test('rejects invalid extension duration (too short)', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [baseEngagement] });

      await expect(
        calculateExtension({
          engagement_id: 12345,
          extension_minutes: 10,  // Less than minimum 15
          client: mockClient,
        })
      ).rejects.toThrow('Invalid extension duration: 10 minutes');
    });

    test('rejects invalid extension duration (too long)', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [baseEngagement] });

      await expect(
        calculateExtension({
          engagement_id: 12345,
          extension_minutes: 500,  // More than maximum 480
          client: mockClient,
        })
      ).rejects.toThrow('Invalid extension duration: 500 minutes');
    });

    test('throws error when engagement not found', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        calculateExtension({
          engagement_id: 99999,
          extension_minutes: 60,
          client: mockClient,
        })
      ).rejects.toThrow('Engagement 99999 not found');
    });
  });

  describe('validateTimeline', () => {
    const now = Math.floor(Date.now() / 1000);
    const logger = require('../../utils/logger');

    test('rejects future start times', async () => {
      const futureStart = now + 3600; // 1 hour in future

      await expect(
        validateTimeline({
          scheduled_start: now,
          scheduled_end: now + 3600,
          actual_start: futureStart,
          duration_minutes: 60,
          engagement_id: 12345,
        })
      ).rejects.toThrow('Start time cannot be in the future');
    });

    test('allows start time within 60s tolerance', async () => {
      const justFuture = now + 30; // 30 seconds in future (within tolerance)

      await expect(
        validateTimeline({
          scheduled_start: now,
          scheduled_end: now + 3600,
          actual_start: justFuture,
          duration_minutes: 60,
          engagement_id: 12345,
        })
      ).resolves.not.toThrow();
    });

    test('warns on extreme early start (> 2 hours)', async () => {
      const veryEarly = now - 9000; // 2.5 hours early

      await validateTimeline({
        scheduled_start: now,
        scheduled_end: now + 3600,
        actual_start: veryEarly,
        duration_minutes: 60,
        engagement_id: 12345,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'Extreme early start detected',
        expect.objectContaining({
          engagement_id: 12345,
          alert_type: 'EXTREME_EARLY_START',
        })
      );
    });

    test('blocks start after scheduled end time', async () => {
      const afterEnd = now + 7200; // 2 hours after

      await expect(
        validateTimeline({
          scheduled_start: now,
          scheduled_end: now + 3600,
          actual_start: afterEnd,
          duration_minutes: 60,
          engagement_id: 12345,
        })
      ).rejects.toThrow('Service cannot start after scheduled end time');
    });

    test('warns when start time is > 24 hours in past', async () => {
      const oldStart = now - 90000; // 25 hours ago

      await validateTimeline({
        scheduled_start: now,
        scheduled_end: now + 3600,
        actual_start: oldStart,
        duration_minutes: 60,
        engagement_id: 12345,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'Start time is more than 24 hours in the past',
        expect.objectContaining({
          engagement_id: 12345,
          alert_type: 'OLD_START_TIME',
        })
      );
    });

    test('warns on unusual duration', async () => {
      await validateTimeline({
        scheduled_start: now,
        scheduled_end: now + 3600,
        actual_start: now - 1800,
        duration_minutes: 500, // More than 480 max
        engagement_id: 12345,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'Unusual duration detected',
        expect.objectContaining({
          engagement_id: 12345,
          duration_minutes: 500,
          alert_type: 'UNUSUAL_DURATION',
        })
      );
    });
  });

  describe('getEffectiveTimeline', () => {
    test('returns actual timeline when recalculated', () => {
      const engagement = {
        start_epoch: 1720101600,
        end_epoch: 1720105200,
        actual_start_epoch: 1720099800,
        actual_end_epoch: 1720103400,
        duration_minutes: 60,
        is_timeline_recalculated: true,
        early_start_minutes: 30,
      };

      const result = getEffectiveTimeline(engagement);

      expect(result).toEqual({
        start_epoch: 1720099800,
        end_epoch: 1720103400,
        is_recalculated: true,
        duration_minutes: 60,
        early_start_minutes: 30,
      });
    });

    test('falls back to scheduled timeline when not recalculated', () => {
      const engagement = {
        start_epoch: 1720101600,
        end_epoch: 1720105200,
        actual_start_epoch: null,
        actual_end_epoch: null,
        duration_minutes: 60,
        is_timeline_recalculated: false,
        early_start_minutes: 0,
      };

      const result = getEffectiveTimeline(engagement);

      expect(result).toEqual({
        start_epoch: 1720101600,
        end_epoch: 1720105200,
        is_recalculated: false,
        duration_minutes: 60,
        early_start_minutes: 0,
      });
    });

    test('calculates duration from epochs when not provided', () => {
      const engagement = {
        start_epoch: 1720101600,
        end_epoch: 1720105200,
        actual_start_epoch: null,
        actual_end_epoch: null,
        duration_minutes: null,
        is_timeline_recalculated: false,
      };

      const result = getEffectiveTimeline(engagement);

      expect(result.duration_minutes).toBe(60);
    });

    test('handles partial recalculation (actual_start but no actual_end)', () => {
      const engagement = {
        start_epoch: 1720101600,
        end_epoch: 1720105200,
        actual_start_epoch: 1720099800,
        actual_end_epoch: null,
        duration_minutes: 60,
        is_timeline_recalculated: true,
      };

      const result = getEffectiveTimeline(engagement);

      expect(result.start_epoch).toBe(1720099800);
      expect(result.end_epoch).toBe(1720105200); // Falls back to scheduled
    });
  });
});
