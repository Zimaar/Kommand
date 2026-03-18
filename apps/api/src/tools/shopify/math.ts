import type { OrderNode } from './orders-read.js';

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function percentChange(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function sumRevenue(orders: OrderNode[]): number {
  return orders.reduce((s, o) => s + parseFloat(o.totalPriceSet.shopMoney.amount), 0);
}
