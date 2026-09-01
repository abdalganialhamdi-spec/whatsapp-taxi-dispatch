/**
 * أنواع البيانات المشتركة — WhatsApp Taxi Dispatch
 * Shared types for the dispatch engine.
 */

export type RideStatus =
  | 'NEW'          // تم الفهم، بانتظار تأكيد الزبون
  | 'DISPATCHING'  // منشورة بمجموعة السواقين، لا سائق بعد
  | 'ASSIGNED'     // سائق قبلها
  | 'ARRIVED'      // السائق وصل للزبون
  | 'IN_RIDE'      // الرحلة جارية
  | 'DONE'         // انتهت (كاش استلم)
  | 'CANCELLED';   // ملغاة (زبون أو ما لقينا سائق)

export type DriverStatus = 'AVAILABLE' | 'BUSY' | 'OFFLINE';

export interface Zone {
  id: number;
  name: string;        // الاسم العامي كما ينطقه الناس
  aliases: string[];   // أسماء بديلة للمطابقة
  belt: number;        // الحزام: 1 = داخل المدينة، 2 = ضواحي، 3 = ريف
}

export interface FixedFare {
  id: number;
  from_zone_id: number;
  to_zone_id: number;
  price: number;       // بالليرة السورية
  note?: string;
}

export interface Driver {
  id: number;
  phone: string;          // 9639XXXXXXXX
  name: string;
  car: string;
  plate: string;
  status: DriverStatus;
  commission_pct: number; // عمولة الشركة، مثال 10
  group_jid: string;      // مجموعة التوزيع التي يتبع لها
}

export interface Client {
  phone: string;      // 9639XXXXXXXX
  name?: string;
  created_at: string;
}

export interface Ride {
  id: number;
  client_phone: string;
  from_zone_id: number | null;
  to_zone_id: number | null;
  from_text: string;   // نص الزبون الخام
  to_text: string;
  price: number | null;
  status: RideStatus;
  driver_id: number | null;
  created_at: string;
  assigned_at: string | null;
  done_at: string | null;
}

export interface Env {
  DB: D1Database;
  // يُضبط عبر wrangler secret put
  ADMIN_KEY: string;
  // جِد optional AI provider (طبقة ثانية فوق الـ NLU القواعدي)
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
}
