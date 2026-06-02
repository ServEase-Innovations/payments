import express from "express";
import {
  handlePostQuote,
  handleListPlans,
  handleGetPlanByBookingType,
} from "../pricing/pricingHandlers.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   - name: Pricing V2
 *     description: |
 *       Checkout pricing engine — quote totals, line items, promo rules, and coupon discounts.
 *       Use **POST /pricing/quote** (web: `/api/pricing/quote`) or **POST /v2/pricing/quote` before create-engagement.
 */

/**
 * @swagger
 * /pricing/quote:
 *   post:
 *     summary: Calculate service price quote
 *     description: |
 *       Returns a pricing snapshot for the booking checkout UI: line items, discounts, applied rules,
 *       and **total** (service subtotal after discounts, before platform fee/GST at payment).
 *
 *       **URLs:** `POST /api/pricing/quote` (web) and `POST /api/v2/pricing/quote` (alias) use the same handler.
 *
 *       **Coupons:** pass `coupon_code` (or `couponCode`) with `customerId`. The payments service
 *       validates via the coupons service and adds a discount line when eligible.
 *
 *       **Cook:** `service_type` COOK uses maid rate plans on the server; maid-only coupons can apply
 *       to cook bookings. Cook-only coupons require `service_type` COOK.
 *
 *       **Rate band:** `ratePreference` `min` | `max` | `mid` picks hourly/package rates from plan bounds.
 *     tags:
 *       - Pricing V2
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - serviceType
 *               - bookingType
 *               - startDate
 *             properties:
 *               serviceType:
 *                 type: string
 *                 description: MAID, COOK, or NANNY (COOK resolves maid plans for rates)
 *                 example: MAID
 *               service_type:
 *                 type: string
 *                 description: Snake-case alias of serviceType
 *                 example: MAID
 *               bookingType:
 *                 type: string
 *                 enum: [ON_DEMAND, SHORT_TERM, MONTHLY]
 *                 example: ON_DEMAND
 *               booking_type:
 *                 type: string
 *                 enum: [ON_DEMAND, SHORT_TERM, MONTHLY]
 *               customerId:
 *                 type: integer
 *                 description: Required when applying a coupon
 *                 example: 39
 *               customer_id:
 *                 type: integer
 *               couponCode:
 *                 type: string
 *                 example: COOK10ALL
 *               coupon_code:
 *                 type: string
 *                 example: ONDM150
 *               city:
 *                 type: string
 *                 description: Optional; used for coupon city rules
 *                 example: Bengaluru
 *               startDate:
 *                 type: string
 *                 format: date
 *                 example: "2026-05-28"
 *               start_date:
 *                 type: string
 *                 format: date
 *               startDateEpoch:
 *                 type: integer
 *                 description: Unix epoch seconds alias for startDate/start_date
 *                 example: 1779926400
 *               start_date_epoch:
 *                 type: integer
 *                 description: Unix epoch seconds alias for start_date
 *                 example: 1779926400
 *               endDate:
 *                 type: string
 *                 format: date
 *                 description: Defaults to startDate when omitted
 *               end_date:
 *                 type: string
 *                 format: date
 *               endDateEpoch:
 *                 type: integer
 *                 description: Unix epoch seconds alias for endDate/end_date
 *                 example: 1782518400
 *               end_date_epoch:
 *                 type: integer
 *                 description: Unix epoch seconds alias for end_date
 *                 example: 1782518400
 *               durationHours:
 *                 type: number
 *                 description: Visit length for ON_DEMAND / per-visit short-term
 *                 example: 1
 *               duration_hours:
 *                 type: number
 *               hoursPerDay:
 *                 type: number
 *                 description: Short-term / monthly hours per day when durationHours not set
 *               hours_per_day:
 *                 type: number
 *               ratePreference:
 *                 type: string
 *                 enum: [min, max, mid]
 *                 default: mid
 *               rate_preference:
 *                 type: string
 *                 enum: [min, max, mid]
 *           examples:
 *             onDemandMaid:
 *               summary: On-demand maid, 1 hour
 *               value:
 *                 serviceType: MAID
 *                 bookingType: ON_DEMAND
 *                 customerId: 39
 *                 startDate: "2026-05-28"
 *                 durationHours: 1
 *                 ratePreference: mid
 *             onDemandWithCoupon:
 *               summary: On-demand with coupon
 *               value:
 *                 serviceType: COOK
 *                 bookingType: ON_DEMAND
 *                 customerId: 39
 *                 coupon_code: COOK10ALL
 *                 startDate: "2026-05-28"
 *                 durationHours: 1
 *     responses:
 *       200:
 *         description: Quote calculated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 total:
 *                   type: number
 *                   description: Payable service subtotal after discounts (before platform fee/GST)
 *                   example: 165
 *                 plan_code:
 *                   type: string
 *                   example: MAID_HOURLY
 *                 quote_id:
 *                   type: integer
 *                   description: Optional row id when quote logging succeeds
 *                 quote:
 *                   type: object
 *                   properties:
 *                     version:
 *                       type: integer
 *                       example: 1
 *                     quoted_at:
 *                       type: string
 *                       format: date-time
 *                     service_type:
 *                       type: string
 *                     booking_type:
 *                       type: string
 *                     subtotal:
 *                       type: number
 *                       description: Service amount before coupon discount
 *                     total:
 *                       type: number
 *                     coupon:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         coupon_code:
 *                           type: string
 *                         coupon_id:
 *                           type: string
 *                         discount_amount:
 *                           type: number
 *                     line_items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           description:
 *                             type: string
 *                           quantity:
 *                             type: number
 *                           unit:
 *                             type: string
 *                           unit_rate:
 *                             type: number
 *                           amount:
 *                             type: number
 *                     discounts:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           label:
 *                             type: string
 *                           amount:
 *                             type: number
 *                     applied_rules:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           rule_type:
 *                             type: string
 *                           label:
 *                             type: string
 *                     display:
 *                       type: object
 *                       description: Rate bands for UI
 *       400:
 *         description: Invalid input, plan not found, duration over limit, or coupon rejected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: Order value is below the minimum amount required for this coupon.
 *       500:
 *         description: Pricing engine or unexpected server error
 */
router.post("/quote", handlePostQuote);

/**
 * @swagger
 * /pricing/plans:
 *   get:
 *     summary: List active pricing plans
 *     description: Returns all active plans with nested pricing rules (admin/checkout reference).
 *     tags:
 *       - Pricing V2
 *     parameters:
 *       - in: query
 *         name: serviceType
 *         schema:
 *           type: string
 *         description: Filter by MAID, COOK, etc.
 *       - in: query
 *         name: service_type
 *         schema:
 *           type: string
 *       - in: query
 *         name: activeOnly
 *         schema:
 *           type: boolean
 *           default: true
 *         description: When false, includes inactive plans
 *     responses:
 *       200:
 *         description: List of plans with rules
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 plans:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       plan_id:
 *                         type: string
 *                       code:
 *                         type: string
 *                       name:
 *                         type: string
 *                       service_type:
 *                         type: string
 *                       booking_type:
 *                         type: string
 *                       unit:
 *                         type: string
 *                         enum: [HOUR, DAY, MONTH]
 *                       base_rate_min:
 *                         type: number
 *                       base_rate_max:
 *                         type: number
 *                       rules:
 *                         type: array
 *                         items:
 *                           type: object
 *       500:
 *         description: Server error
 */
router.get("/plans", handleListPlans);

/**
 * @swagger
 * /pricing/plans/{serviceType}/{bookingType}:
 *   get:
 *     summary: Active plan and rules for checkout
 *     description: |
 *       Single active plan for a service + booking type (e.g. MAID + ON_DEMAND).
 *       COOK resolves to maid plans until dedicated cook plans exist.
 *     tags:
 *       - Pricing V2
 *     parameters:
 *       - in: path
 *         name: serviceType
 *         required: true
 *         schema:
 *           type: string
 *         example: MAID
 *       - in: path
 *         name: bookingType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [ON_DEMAND, SHORT_TERM, MONTHLY]
 *         example: ON_DEMAND
 *     responses:
 *       200:
 *         description: Plan and rules found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 plan:
 *                   type: object
 *                 rules:
 *                   type: array
 *                   items:
 *                     type: object
 *       404:
 *         description: No active plan for this combination
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: Plan not found
 *       500:
 *         description: Server error
 */
router.get("/plans/:serviceType/:bookingType", handleGetPlanByBookingType);

export default router;
