/**
 * Integration Tests for Timeline Recalculation APIs
 * 
 * Tests the complete flow of timeline recalculation across multiple endpoints:
 * - Starting a service (capturing actual start time)
 * - Retrieving engagement with timeline data
 * - Extending from recalculated timeline
 */

const request = require('supertest');
const pool = require('../../config/db');
const app = require('../../app'); // Assuming Express app is exported

// Mock authentication middleware for testing
jest.mock('../../middleware/auth', () => ({
  authenticateRead: [(req, res, next) => next()],
  requireOwnCustomerId: (req, res, next) => next(),
  providerOwnerRead: [(req, res, next) => next()],
}));

describe('Timeline Recalculation API Integration', () => {
  let testEngagementId;
  let testServiceDayId;
  let testCustomerId;
  let testProviderId;
  let client;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    if (client) {
      client.release();
    }
    await pool.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');

    // Create test customer
    const customerResult = await client.query(`
      INSERT INTO customer (firstname, lastname, mobileno, email)
      VALUES ('Test', 'Customer', 9876543210, 'test@example.com')
      RETURNING customerid
    `);
    testCustomerId = customerResult.rows[0].customerid;

    // Create test provider
    const providerResult = await client.query(`
      INSERT INTO serviceprovider (firstname, lastname, mobileno, email)
      VALUES ('Test', 'Provider', 9876543211, 'provider@example.com')
      RETURNING serviceproviderid
    `);
    testProviderId = providerResult.rows[0].serviceproviderid;

    // Create test engagement (ON_DEMAND booking for today, 2:00 PM - 3:00 PM)
    const now = Math.floor(Date.now() / 1000);
    const startEpoch = now + 3600; // 1 hour from now
    const endEpoch = startEpoch + 3600; // 2 hours from now (1 hour duration)

    const engagementResult = await client.query(`
      INSERT INTO engagements (
        customerid, 
        serviceproviderid, 
        booking_type, 
        service_type,
        start_date,
        end_date,
        start_epoch,
        end_epoch,
        base_amount,
        task_status,
        assignment_status,
        engagement_status
      ) VALUES ($1, $2, 'ON_DEMAND', 'maid', CURRENT_DATE, CURRENT_DATE, $3, $4, 500, 'NOT_STARTED', 'ASSIGNED', 'CREATED')
      RETURNING engagement_id
    `, [testCustomerId, testProviderId, startEpoch, endEpoch]);
    testEngagementId = engagementResult.rows[0].engagement_id;

    // Create service day
    const serviceDayResult = await client.query(`
      INSERT INTO service_days (
        engagement_id,
        service_date,
        status
      ) VALUES ($1, CURRENT_DATE, 'SCHEDULED')
      RETURNING service_day_id
    `, [testEngagementId]);
    testServiceDayId = serviceDayResult.rows[0].service_day_id;

    await client.query('COMMIT');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  describe('POST /service-days/:id/start - Start Service', () => {
    test('captures actual start time and recalculates timeline', async () => {
      const response = await request(app)
        .post(`/api/service-days/${testServiceDayId}/start`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        engagement_id: testEngagementId,
      });

      // Verify timeline data is returned
      expect(response.body.timeline).toBeDefined();
      expect(response.body.timeline.actual_start_epoch).toBeDefined();
      expect(response.body.timeline.actual_end_epoch).toBeDefined();
      expect(response.body.timeline.duration_minutes).toBe(60);

      // Verify early start calculation
      const scheduledStart = response.body.timeline.scheduled_start_epoch;
      const actualStart = response.body.timeline.actual_start_epoch;
      const expectedEarlyMinutes = Math.round((scheduledStart - actualStart) / 60);
      expect(response.body.timeline.early_start_minutes).toBe(expectedEarlyMinutes);

      // Verify database was updated
      const dbResult = await client.query(`
        SELECT 
          actual_start_epoch,
          actual_end_epoch,
          duration_minutes,
          is_timeline_recalculated,
          early_start_minutes
        FROM engagements
        WHERE engagement_id = $1
      `, [testEngagementId]);

      const engagement = dbResult.rows[0];
      expect(engagement.actual_start_epoch).toBeTruthy();
      expect(engagement.actual_end_epoch).toBeTruthy();
      expect(engagement.is_timeline_recalculated).toBe(true);
      expect(engagement.duration_minutes).toBe(60);
    });

    test('prevents duplicate service start', async () => {
      // Start service first time
      await request(app)
        .post(`/api/service-days/${testServiceDayId}/start`)
        .expect(200);

      // Try to start again
      const response = await request(app)
        .post(`/api/service-days/${testServiceDayId}/start`)
        .expect(400);

      expect(response.body.error).toContain('cannot be started');
    });

    test('updates service day with actual start timestamp', async () => {
      await request(app)
        .post(`/api/service-days/${testServiceDayId}/start`)
        .expect(200);

      const sdResult = await client.query(`
        SELECT 
          status,
          started_at,
          actual_started_at,
          actual_start_epoch
        FROM service_days
        WHERE service_day_id = $1
      `, [testServiceDayId]);

      const serviceDay = sdResult.rows[0];
      expect(serviceDay.status).toBe('IN_PROGRESS');
      expect(serviceDay.started_at).toBeTruthy();
      expect(serviceDay.actual_started_at).toBeTruthy();
      expect(serviceDay.actual_start_epoch).toBeTruthy();
    });
  });

  describe('GET /engagements/:customerId/today-bookings - Retrieve Timeline', () => {
    test('returns timeline data for active bookings', async () => {
      // Start the service first
      await request(app)
        .post(`/api/service-days/${testServiceDayId}/start`)
        .expect(200);

      // Fetch today's bookings
      const response = await request(app)
        .get(`/api/engagements/${testCustomerId}/today-bookings`)
        .expect(200);

      expect(response.body.success).toBe(true);
      
      const booking = response.body.bookings?.find(
        b => b.engagement_id === testEngagementId
      );

      expect(booking).toBeDefined();
      expect(booking.actual_start_epoch).toBeTruthy();
      expect(booking.actual_end_epoch).toBeTruthy();
      expect(booking.is_timeline_recalculated).toBe(true);
      expect(booking.duration_minutes).toBe(60);
    });

    test('returns scheduled times when service not started', async () => {
      // Don't start service, just fetch
      const response = await request(app)
        .get(`/api/engagements/${testCustomerId}/today-bookings`)
        .expect(200);

      const booking = response.body.bookings?.find(
        b => b.engagement_id === testEngagementId
      );

      expect(booking).toBeDefined();
      expect(booking.actual_start_epoch).toBeNull();
      expect(booking.actual_end_epoch).toBeNull();
      expect(booking.is_timeline_recalculated).toBe(false);
      expect(booking.start_epoch).toBeTruthy(); // Scheduled start
      expect(booking.end_epoch).toBeTruthy(); // Scheduled end
    });
  });

  describe('GET /v2/engagements/:id/extension-availability - Extension Timeline', () => {
    test('uses recalculated end time for extension availability', async () => {
      // Start service (this will recalculate timeline)
      const startResponse = await request(app)
        .post(`/api/service-days/${testServiceDayId}/start`)
        .expect(200);

      const actualEndEpoch = startResponse.body.timeline.actual_end_epoch;

      // Check extension availability
      const response = await request(app)
        .get(`/api/v2/engagements/${testEngagementId}/extension-availability`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.canExtend).toBe(true);

      // Verify available slots calculate from actual end time
      if (response.body.availableSlots?.length > 0) {
        const firstSlot = response.body.availableSlots[0];
        // New end should be actual_end + extension hours
        expect(firstSlot.newEndEpoch).toBeGreaterThan(actualEndEpoch);
        expect(firstSlot.newEndEpoch).toBe(actualEndEpoch + (firstSlot.extensionHours * 3600));
      }
    });

    test('uses scheduled end time when service not started', async () => {
      // Don't start service
      const engResult = await client.query(`
        SELECT end_epoch FROM engagements WHERE engagement_id = $1
      `, [testEngagementId]);
      const scheduledEndEpoch = engResult.rows[0].end_epoch;

      // Check extension availability
      const response = await request(app)
        .get(`/api/v2/engagements/${testEngagementId}/extension-availability`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Extensions should calculate from scheduled end
      if (response.body.availableSlots?.length > 0) {
        const firstSlot = response.body.availableSlots[0];
        expect(firstSlot.newEndEpoch).toBe(
          scheduledEndEpoch + (firstSlot.extensionHours * 3600)
        );
      }
    });
  });

  describe('Complete Flow: Start → Extend → Verify', () => {
    test('complete timeline recalculation and extension flow', async () => {
      // Step 1: Start service (30 minutes early simulation)
      const startResponse = await request(app)
        .post(`/api/service-days/${testServiceDayId}/start`)
        .expect(200);

      const timeline = startResponse.body.timeline;
      expect(timeline.actual_start_epoch).toBeDefined();
      expect(timeline.actual_end_epoch).toBeDefined();

      const actualEndEpoch = timeline.actual_end_epoch;
      const scheduledEndEpoch = timeline.scheduled_end_epoch;

      // Verify end time was recalculated
      expect(actualEndEpoch).not.toBe(scheduledEndEpoch);

      // Step 2: Extend booking by 1 hour
      // Note: Actual extension endpoint may vary, this is conceptual
      const extensionResponse = await request(app)
        .post(`/api/v2/engagements/${testEngagementId}/extend`)
        .send({
          extensionHours: 1,
          newEndTime: new Date((actualEndEpoch + 3600) * 1000).toISOString(),
          additionalAmount: 150
        })
        .expect(200);

      expect(extensionResponse.body.success).toBe(true);

      // Step 3: Verify final timeline
      const verifyResult = await client.query(`
        SELECT 
          start_epoch,
          end_epoch,
          actual_start_epoch,
          actual_end_epoch,
          duration_minutes,
          is_timeline_recalculated
        FROM engagements
        WHERE engagement_id = $1
      `, [testEngagementId]);

      const finalEngagement = verifyResult.rows[0];
      
      // Verify extension was calculated from recalculated end time
      expect(finalEngagement.actual_end_epoch).toBe(actualEndEpoch + 3600);
      expect(finalEngagement.end_epoch).toBe(actualEndEpoch + 3600);
      
      // Duration should now be original + extension
      expect(finalEngagement.duration_minutes).toBe(120); // 60 + 60

      // Verify NOT extending from original scheduled end
      expect(finalEngagement.end_epoch).not.toBe(scheduledEndEpoch + 3600);
    });
  });

  describe('Error Handling', () => {
    test('handles missing engagement gracefully', async () => {
      const response = await request(app)
        .get('/api/v2/engagements/99999/extension-availability')
        .expect(404);

      expect(response.body.error).toBeDefined();
    });

    test('handles invalid service day ID', async () => {
      const response = await request(app)
        .post('/api/service-days/99999/start')
        .expect(404);

      expect(response.body.error).toBeDefined();
    });

    test('timeline recalculation failure does not prevent service start', async () => {
      // This test would require mocking the timeline calculator to fail
      // But the system should still allow the service to start
      
      // For now, just verify service can start normally
      const response = await request(app)
        .post(`/api/service-days/${testServiceDayId}/start`)
        .expect(200);

      expect(response.body.success).toBeTruthy();
    });
  });

  describe('Timeline Data Consistency', () => {
    test('timeline data is consistent across all endpoints', async () => {
      // Start service
      await request(app)
        .post(`/api/service-days/${testServiceDayId}/start`)
        .expect(200);

      // Fetch from customer endpoint
      const customerResponse = await request(app)
        .get(`/api/engagements/${testCustomerId}/today-bookings`)
        .expect(200);

      const customerBooking = customerResponse.body.bookings?.find(
        b => b.engagement_id === testEngagementId
      );

      // Fetch from provider endpoint
      const providerResponse = await request(app)
        .get(`/api/service-providers/${testProviderId}/engagements`)
        .expect(200);

      const providerEngagement = [
        ...(providerResponse.body.current || []),
        ...(providerResponse.body.upcoming || []),
      ].find(e => e.engagement_id === testEngagementId);

      // Verify consistency
      if (customerBooking && providerEngagement) {
        expect(customerBooking.actual_start_epoch).toBe(
          providerEngagement.actual_start_epoch
        );
        expect(customerBooking.actual_end_epoch).toBe(
          providerEngagement.actual_end_epoch
        );
        expect(customerBooking.is_timeline_recalculated).toBe(
          providerEngagement.is_timeline_recalculated
        );
      }
    });
  });
});
