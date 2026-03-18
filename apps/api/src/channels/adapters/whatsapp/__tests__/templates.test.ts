import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendTemplate,
  formatMorningBrief,
  formatOrderNotification,
  formatInventoryAlert,
  formatComparison,
  generateSalesChart,
  type BusinessSummary,
  type OrderData,
  type ProductData,
  type PeriodSummary,
  type ChartDataPoint,
} from '../templates.js';

// ─── Shared fixture helpers ───────────────────────────────────────────────────

function makeSummary(overrides: Partial<BusinessSummary> = {}): BusinessSummary {
  return {
    period: 'today',
    storeName: 'Acme Store',
    ownerName: 'Sarah',
    orders: {
      count: 45,
      revenue: 12500,
      averageOrderValue: 277.78,
      currency: 'AED',
      vsLastPeriod: { change: 12.5, previousRevenue: 11111.11 },
    },
    bestSellers: [
      { productTitle: 'Blue T-Shirt', unitsSold: 18, revenue: 2700 },
      { productTitle: 'Cap', unitsSold: 10, revenue: 1500 },
      { productTitle: 'Hoodie', unitsSold: 8, revenue: 2400 },
    ],
    newCustomers: 7,
    unfulfilledOrders: 2,
    alerts: ['Revenue is down 25.0% vs last period'],
    ...overrides,
  };
}

// ─── sendTemplate ─────────────────────────────────────────────────────────────

describe('sendTemplate', () => {
  const mockSendTemplate = vi.fn().mockResolvedValue({ messageId: 'wamid.test', status: 'sent' });
  // Minimal WhatsAppSender mock
  const mockSender = { sendTemplate: mockSendTemplate } as never;

  beforeEach(() => {
    mockSendTemplate.mockClear();
  });

  it('calls sender.sendTemplate with correct template name and language', async () => {
    await sendTemplate(mockSender, '+971501234567', 'morning_brief', {
      name: 'Sarah',
      body: 'Revenue: AED 12,500',
    });

    expect(mockSendTemplate).toHaveBeenCalledOnce();
    const [to, templateName, langCode, components] = mockSendTemplate.mock.calls[0];
    expect(to).toBe('+971501234567');
    expect(templateName).toBe('morning_brief');
    expect(langCode).toBe('en_US');
    expect(components).toHaveLength(1);
    expect(components[0].type).toBe('body');
  });

  it('maps named params to positional text parameters in template order', async () => {
    await sendTemplate(mockSender, '+971501234567', 'morning_brief', {
      name: 'Ahmed',
      body: 'Good day!',
    });

    const components = mockSendTemplate.mock.calls[0][3];
    expect(components[0].parameters).toEqual([
      { type: 'text', text: 'Ahmed' },    // {{1}} = name
      { type: 'text', text: 'Good day!' }, // {{2}} = body
    ]);
  });

  it('uses empty string for missing params (graceful degradation)', async () => {
    await sendTemplate(mockSender, '+971501234567', 'alert', {
      store_name: 'Acme',
      // body intentionally omitted
    });

    const components = mockSendTemplate.mock.calls[0][3];
    expect(components[0].parameters[1]).toEqual({ type: 'text', text: '' });
  });

  it('throws for unknown template names', async () => {
    await expect(
      sendTemplate(mockSender, '+971501234567', 'nonexistent_template', {})
    ).rejects.toThrow('Unknown template "nonexistent_template"');
  });

  it('maps "confirmation" template with single param', async () => {
    await sendTemplate(mockSender, '+14155552671', 'confirmation', {
      body: 'Confirm your order?',
    });

    const components = mockSendTemplate.mock.calls[0][3];
    expect(components[0].parameters).toEqual([
      { type: 'text', text: 'Confirm your order?' },
    ]);
  });
});

// ─── formatMorningBrief ───────────────────────────────────────────────────────

describe('formatMorningBrief', () => {
  it('includes personalised greeting when ownerName is set', () => {
    const msg = formatMorningBrief(makeSummary());
    expect(msg).toContain('Good morning, Sarah!');
  });

  it('falls back to generic greeting when ownerName is absent', () => {
    const msg = formatMorningBrief(makeSummary({ ownerName: undefined }));
    expect(msg).toContain('Good morning!');
  });

  it('includes store name in subheading when storeName is set', () => {
    const msg = formatMorningBrief(makeSummary());
    expect(msg).toContain('Acme Store');
  });

  it('includes formatted revenue with currency', () => {
    const msg = formatMorningBrief(makeSummary());
    expect(msg).toContain('AED 12,500.00');
  });

  it('shows positive change arrow (↑) for revenue increase', () => {
    const msg = formatMorningBrief(makeSummary());
    expect(msg).toContain('↑12.5%');
  });

  it('shows negative change arrow (↓) for revenue decrease', () => {
    const msg = formatMorningBrief(
      makeSummary({ orders: { ...makeSummary().orders, vsLastPeriod: { change: -8.3, previousRevenue: 13600 } } })
    );
    expect(msg).toContain('↓8.3%');
  });

  it('includes order count and AOV', () => {
    const msg = formatMorningBrief(makeSummary());
    expect(msg).toContain('45 orders');
    expect(msg).toContain('AOV: AED 277.78');
  });

  it('shows unfulfilled count when > 0', () => {
    const msg = formatMorningBrief(makeSummary());
    expect(msg).toContain('2 unfulfilled');
  });

  it('omits unfulfilled line when count is 0', () => {
    const msg = formatMorningBrief(makeSummary({ unfulfilledOrders: 0 }));
    expect(msg).not.toContain('unfulfilled');
  });

  it('lists all best sellers', () => {
    const msg = formatMorningBrief(makeSummary());
    expect(msg).toContain('Blue T-Shirt');
    expect(msg).toContain('Cap');
    expect(msg).toContain('Hoodie');
  });

  it('shows new customer count', () => {
    const msg = formatMorningBrief(makeSummary());
    expect(msg).toContain('New customers: 7');
  });

  it('shows alerts section when alerts present', () => {
    const msg = formatMorningBrief(makeSummary());
    expect(msg).toContain('🚨');
    expect(msg).toContain('Revenue is down 25.0% vs last period');
  });

  it('omits alerts section when alerts array is empty', () => {
    const msg = formatMorningBrief(makeSummary({ alerts: [] }));
    expect(msg).not.toContain('🚨');
  });

  it('omits top sellers section when bestSellers is empty', () => {
    const msg = formatMorningBrief(makeSummary({ bestSellers: [] }));
    expect(msg).not.toContain('Top Sellers');
  });
});

// ─── formatOrderNotification ──────────────────────────────────────────────────

describe('formatOrderNotification', () => {
  const order: OrderData = {
    number: '1042',
    customer: 'Jane Smith',
    currency: 'AED',
    total: 350,
  };

  it('contains order number, customer name, and currency+total', () => {
    const msg = formatOrderNotification(order);
    expect(msg).toContain('#1042');
    expect(msg).toContain('Jane Smith');
    expect(msg).toContain('AED 350.00');
  });

  it('starts with the parcel emoji', () => {
    expect(formatOrderNotification(order)).toMatch(/^📦/);
  });
});

// ─── formatInventoryAlert ─────────────────────────────────────────────────────

describe('formatInventoryAlert', () => {
  const product: ProductData = {
    name: 'Blue T-Shirt (M)',
    count: 5,
    dailyRate: 2.3,
  };

  it('includes product name and unit count', () => {
    const msg = formatInventoryAlert(product);
    expect(msg).toContain('Blue T-Shirt (M)');
    expect(msg).toContain('5 units');
  });

  it('includes calculated days supply', () => {
    const msg = formatInventoryAlert(product);
    // floor(5 / 2.3) = 2 days
    expect(msg).toContain('~2 days supply');
  });

  it('handles daily rate of 0 gracefully (omits days calc)', () => {
    const msg = formatInventoryAlert({ name: 'Widget', count: 3, dailyRate: 0 });
    expect(msg).not.toContain('days supply');
    expect(msg).toContain('3 units');
  });

  it('uses singular "unit" when count is 1', () => {
    const msg = formatInventoryAlert({ name: 'Widget', count: 1, dailyRate: 0.5 });
    expect(msg).toContain('1 unit left');
    expect(msg).not.toContain('1 units');
  });

  it('uses singular "day" when days left is 1', () => {
    const msg = formatInventoryAlert({ name: 'Widget', count: 1, dailyRate: 1 });
    expect(msg).toContain('~1 day supply');
    expect(msg).not.toContain('1 days');
  });

  it('starts with the warning emoji', () => {
    expect(formatInventoryAlert(product)).toMatch(/^⚠️/);
  });
});

// ─── formatComparison ─────────────────────────────────────────────────────────

describe('formatComparison', () => {
  const periodA: PeriodSummary = {
    label: 'This Week',
    revenue: 12500,
    orders: 45,
    aov: 277.78,
    currency: 'AED',
  };

  const periodB: PeriodSummary = {
    label: 'Last Week',
    revenue: 11111.11,
    orders: 38,
    aov: 292.4,
    currency: 'AED',
  };

  it('includes both period labels', () => {
    const msg = formatComparison(periodA, periodB);
    expect(msg).toContain('This Week');
    expect(msg).toContain('Last Week');
  });

  it('shows revenue for both periods', () => {
    const msg = formatComparison(periodA, periodB);
    expect(msg).toContain('AED 12,500.00');
    expect(msg).toContain('AED 11,111.11');
  });

  it('shows up arrow when periodA revenue is higher than periodB', () => {
    const msg = formatComparison(periodA, periodB);
    // Revenue: 12500 vs 11111 → positive change → ↑
    expect(msg).toMatch(/💰.*↑/s);
  });

  it('shows down arrow when periodA AOV is lower than periodB', () => {
    const msg = formatComparison(periodA, periodB);
    // AOV: 277.78 vs 292.4 → negative → ↓
    expect(msg).toMatch(/🛒.*↓/s);
  });

  it('handles identical periods (flat arrow)', () => {
    const msg = formatComparison(periodA, periodA);
    // All changes are 0 → →
    expect(msg).toContain('→0.0%');
  });

  it('handles zero-revenue periodB gracefully (no division by zero)', () => {
    const b: PeriodSummary = { ...periodB, revenue: 0, orders: 0, aov: 0 };
    expect(() => formatComparison(periodA, b)).not.toThrow();
  });
});

// ─── generateSalesChart ───────────────────────────────────────────────────────

describe('generateSalesChart', () => {
  const dataPoints: ChartDataPoint[] = [
    { date: 'Mon', value: 1000 },
    { date: 'Tue', value: 1500 },
    { date: 'Wed', value: 1200 },
    { date: 'Thu', value: 1800 },
    { date: 'Fri', value: 2100 },
  ];

  it('returns a QuickChart URL', () => {
    const url = generateSalesChart(dataPoints, 'Revenue (AED)');
    expect(url).toMatch(/^https:\/\/quickchart\.io\/chart\?c=/);
  });

  it('includes width, height, and bkg params', () => {
    const url = generateSalesChart(dataPoints, 'Revenue');
    expect(url).toContain('width=400');
    expect(url).toContain('height=220');
    expect(url).toContain('bkg=white');
    expect(url).toContain('format=png');
  });

  it('encodes a line chart type in the config', () => {
    const url = generateSalesChart(dataPoints, 'Revenue');
    const cParam = new URLSearchParams(url.split('?')[1]).get('c')!;
    const config = JSON.parse(decodeURIComponent(cParam));
    expect(config.type).toBe('line');
  });

  it('includes all labels and values from data points', () => {
    const url = generateSalesChart(dataPoints, 'Revenue');
    const cParam = new URLSearchParams(url.split('?')[1]).get('c')!;
    const config = JSON.parse(decodeURIComponent(cParam));
    expect(config.data.labels).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(config.data.datasets[0].data).toEqual([1000, 1500, 1200, 1800, 2100]);
  });

  it('embeds the title in the chart config', () => {
    const url = generateSalesChart(dataPoints, 'Weekly Revenue');
    const cParam = new URLSearchParams(url.split('?')[1]).get('c')!;
    const config = JSON.parse(decodeURIComponent(cParam));
    expect(config.options.plugins.title.text).toBe('Weekly Revenue');
  });

  it('handles empty data array without throwing', () => {
    expect(() => generateSalesChart([], 'Empty')).not.toThrow();
  });
});
