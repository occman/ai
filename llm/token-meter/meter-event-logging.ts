import type Stripe from 'stripe';
import type {UsageEvent, MeterConfig} from './meter-event-types';

/**
 * Normalize model names to match Stripe's approved model list
 */
function normalizeModelName(provider: string, model: string): string {
  if (provider === 'anthropic') {
    // Remove date suffix (YYYYMMDD format at the end)
    model = model.replace(/-\d{8}$/, '');

    // Remove -latest suffix
    model = model.replace(/-latest$/, '');

    // Convert version number dashes to dots anywhere in the name
    // Match patterns like claude-3-7, opus-4-1, sonnet-4-5, etc.
    model = model.replace(/(-[a-z]+)?-(\d+)-(\d+)/g, '$1-$2.$3');

    return model;
  }

  if (provider === 'openai') {
    // Exception: keep gpt-4o-2024-05-13 as is
    if (model === 'gpt-4o-2024-05-13') {
      return model;
    }

    // Remove date suffix in format -YYYY-MM-DD
    model = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');

    return model;
  }

  // For other providers (google), return as is
  return model;
}

/**
 * Build the `<provider>/<model>` name sent to Stripe.
 *
 * OpenRouter model slugs are already `<vendor>/<model>[:variant]`, so the
 * vendor becomes the Stripe provider segment and the variant suffix is
 * dropped (`anthropic/claude-sonnet-4:thinking` -> `anthropic/claude-sonnet-4`).
 * Slugs without a vendor fall back to `openrouter/<model>`.
 */
export function buildStripeModelName(provider: string, model: string): string {
  if (provider === 'openrouter') {
    const slug = model.replace(/:[^/]*$/, '');
    const separator = slug.indexOf('/');
    if (separator === -1) {
      return 'openrouter/' + slug;
    }
    const vendor = slug.slice(0, separator);
    const vendorModel = slug.slice(separator + 1);
    return vendor + '/' + normalizeModelName(vendor, vendorModel);
  }

  return provider + '/' + normalizeModelName(provider, model);
}

/**
 * Send meter events to Stripe
 */
export async function sendMeterEventsToStripe(
  stripeClient: Stripe,
  config: MeterConfig,
  event: UsageEvent
): Promise<void> {
  const timestamp = new Date().toISOString();

  // Normalize the model name before sending to Stripe
  const fullModelName = buildStripeModelName(event.provider, event.model);

  try {
    if (event.usage.inputTokens > 0) {
      const inputPayload = {
        event_name: 'token-billing-tokens',
        timestamp,
        payload: {
          stripe_customer_id: event.stripeCustomerId,
          value: event.usage.inputTokens.toString(),
          model: fullModelName,
          token_type: 'input',
        },
      };
      await stripeClient.v2.billing.meterEvents.create(inputPayload);
    }

    if (event.usage.outputTokens > 0) {
      const outputPayload = {
        event_name: 'token-billing-tokens',
        timestamp,
        payload: {
          stripe_customer_id: event.stripeCustomerId,
          value: event.usage.outputTokens.toString(),
          model: fullModelName,
          token_type: 'output',
        },
      };
      await stripeClient.v2.billing.meterEvents.create(outputPayload);
    }
  } catch (error) {
    console.error('Error sending meter events to Stripe:', error);
  }
}

/**
 * Log usage event (fire-and-forget style)
 */
export function logUsageEvent(
  stripeClient: Stripe,
  config: MeterConfig,
  event: UsageEvent
): void {
  sendMeterEventsToStripe(stripeClient, config, event).catch((err) => {
    console.error('Failed to send meter events to Stripe:', err);
  });
}


