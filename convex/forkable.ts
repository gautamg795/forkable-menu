import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

interface ForkableResponse {
  date: string;
  lunch: Array<{
    restaurant: string;
    items: string[];
  }>;
  success: boolean;
}

interface ErrorResponse {
  error: string;
  status?: number;
}

function getDaysAhead(): number {
  const timezone = process.env.TIMEZONE || 'America/Los_Angeles';
  const now = new Date();
  const sfTime = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).format(now);

  const hour = parseInt(sfTime);
  return hour >= 13 ? 1 : 0; // Tomorrow if 1pm or later, otherwise today
}



function formatLunchResponse(result: ForkableResponse | ErrorResponse): string {
  if (!("success" in result) || !result.success) {
    return "error" in result ? result.error : "Unknown error";
  }

  const lunchItems = result.lunch || [];
  if (lunchItems.length === 0) {
    return "No lunch ordered";
  }

  const responses = lunchItems
    .map((item) => {
      const restaurant = item.restaurant;
      const foodItems = item.items || [];
      if (foodItems.length > 0) {
        const foodList = foodItems.join(", ");
        return `${restaurant}: ${foodList}`;
      }
      return null;
    })
    .filter(Boolean);

  return responses.length > 0 ? responses.join(". ") : "No lunch ordered";
}

// Session management functions
export const getCachedSession = internalQuery({
  args: { email: v.string() },
  returns: v.union(v.null(), v.object({
    _id: v.id("forkable_sessions"),
    _creationTime: v.number(),
    email: v.string(),
    cookie: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const now = Date.now();
    const session = await ctx.db
      .query("forkable_sessions")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .filter((q) => q.gt(q.field("expiresAt"), now))
      .first();

    return session;
  },
});

export const storeCachedSession = internalMutation({
  args: {
    email: v.string(),
    cookie: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Delete existing session for this email
    const existingSession = await ctx.db
      .query("forkable_sessions")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();

    if (existingSession) {
      await ctx.db.delete(existingSession._id);
    }

    // Store new session
    await ctx.db.insert("forkable_sessions", {
      email: args.email,
      cookie: args.cookie,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });

    return null;
  },
});

async function loginAndGetSession(email: string, password: string): Promise<{ cookie: string; expiresAt: number } | null> {
  const loginQuery = {
    query: `mutation ($input: CreateSessionInput!) { 
      createSession (input: $input) { 
        errorAttributes 
        user { id firstName email } 
      } 
    }`,
    variables: {
      input: {
        email,
        password,
      },
    },
  };

  try {
    console.debug("Logging in to Forkable");
    const loginResponse = await fetch("https://forkable.com/api/v2/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(loginQuery),
    });

    if (!loginResponse.ok) {
      console.error(`Login failed with status ${loginResponse.status}`);
      return null;
    }

    const loginData = await loginResponse.json();
    if (loginData?.data?.createSession?.errorAttributes) {
      console.error("Invalid credentials");
      return null;
    }

    // Extract cookies from login response
    const setCookieHeaders = loginResponse.headers.get("set-cookie");
    if (!setCookieHeaders) {
      console.error("No cookies received from login");
      return null;
    }

    // Parse cookies to find the session cookie and its expiration
    console.debug("Raw set-cookie headers:", setCookieHeaders);

    // The set-cookie header format is complex - let's parse it more carefully
    // Look for the _easyorder_session cookie and its expiration
    let sessionCookie = "";
    let expiresAt = Date.now() + (23 * 60 * 60 * 1000); // fallback to 23 hours

    // Find the _easyorder_session cookie in the header
    const sessionMatch = setCookieHeaders.match(/_easyorder_session=([^;]+)/);
    if (!sessionMatch) {
      console.error("No _easyorder_session cookie found in login response");
      return null;
    }

    sessionCookie = `_easyorder_session=${sessionMatch[1]}`;
    console.debug("Found session cookie:", sessionCookie);

    // Look for the expiration date that follows the session cookie
    const sessionCookieIndex = setCookieHeaders.indexOf("_easyorder_session=");
    if (sessionCookieIndex !== -1) {
      const afterSessionCookie = setCookieHeaders.substring(sessionCookieIndex);
      // Look for a date pattern that follows the session cookie
      const dateMatch = afterSessionCookie.match(/(\d{1,2}\s+\w+\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/);
      if (dateMatch) {
        const expiresString = dateMatch[1];
        console.debug("Found expiration string:", expiresString);
        const expiresDate = new Date(expiresString);
        if (!isNaN(expiresDate.getTime())) {
          // Set expiration to 1 hour before the actual expiration as a safety buffer
          expiresAt = expiresDate.getTime() - (60 * 60 * 1000);
          console.debug("Parsed expiration date:", new Date(expiresAt));
        } else {
          console.warn("Could not parse expiration date:", expiresString);
        }
      } else {
        console.warn("Could not find expiration date pattern after session cookie");
      }
    }

    const cookies = sessionCookie;

    console.debug("Successfully logged in to Forkable");
    return { cookie: cookies, expiresAt };
  } catch (error) {
    console.error("Login error:", error);
    return null;
  }
}

async function fetchLunchWithSession(sessionCookie: string, targetDateStr: string): Promise<ForkableResponse | ErrorResponse> {
  const lunchQuery = {
    query: `query { 
      myDeliveries (from: "${targetDateStr}") { 
        forDeliveryAt 
        orders { 
          venue { displayName } 
          pieces { name } 
        } 
      } 
    }`,
    variables: {},
  };

  const lunchHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Cookie": sessionCookie,
  };

  console.debug("Fetching lunch data");
  const lunchResponse = await fetch("https://forkable.com/api/v2/graphql", {
    method: "POST",
    headers: lunchHeaders,
    body: JSON.stringify(lunchQuery),
  });

  if (!lunchResponse.ok) {
    return {
      error: `Failed to fetch lunch data with status ${lunchResponse.status}`,
      status: lunchResponse.status,
    };
  }

  const data = await lunchResponse.json();

  // Check if the response indicates authentication failure
  if (data?.errors?.some((error: any) =>
    error.message?.includes("unauthenticated") ||
    error.message?.includes("unauthorized") ||
    error.extensions?.code === "UNAUTHENTICATED"
  )) {
    return {
      error: "Authentication failed",
      status: 401,
    };
  }

  // Parse response for target date's lunch
  const lunchInfo: Array<{ restaurant: string; items: string[] }> = [];
  const deliveries = data?.data?.myDeliveries || [];

  for (const delivery of deliveries) {
    const deliveryDate = delivery.forDeliveryAt?.slice(0, 10);

    if (deliveryDate === targetDateStr) {
      for (const order of delivery.orders || []) {
        if (order.pieces && order.pieces.length > 0) {
          const restaurant = order.venue?.displayName || "Unknown Restaurant";
          const items = order.pieces.map((piece: any) => piece.name || "");
          lunchInfo.push({
            restaurant,
            items: items.filter(Boolean),
          });
        }
      }
    }
  }

  console.debug("Successfully fetched lunch data");

  return {
    date: targetDateStr,
    lunch: lunchInfo,
    success: true,
  };
}

export const getLunch = httpAction(async (ctx, request) => {
  // Check authorization
  const authToken = request.headers.get("Authorization");
  const expectedToken = process.env.FORKABLE_AUTH_TOKEN;

  if (!expectedToken || authToken !== `Bearer ${expectedToken}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get credentials from environment
  const email = process.env.FORKABLE_EMAIL;
  const password = process.env.FORKABLE_PASSWORD;

  if (!email || !password) {
    return new Response(JSON.stringify({ error: "Missing credentials" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const daysAhead = getDaysAhead();
    const timezone = process.env.TIMEZONE || 'America/Los_Angeles';
    
    // Calculate target date in the same timezone used for time checking
    const now = new Date();
    const currentDateInTz = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    
    // Parse the timezone-adjusted date and add days
    const [year, month, day] = currentDateInTz.split('-').map(Number);
    const targetDate = new Date(year, month - 1, day + daysAhead);
    const targetDateStr = targetDate.toISOString().split("T")[0];

    // Try to get cached session first
    let sessionCookie = "";
    let shouldLogin = false;

    const cachedSession = await ctx.runQuery(internal.forkable.getCachedSession, { email });

    if (cachedSession) {
      console.debug("Using cached session");
      sessionCookie = cachedSession.cookie;

      // Try to fetch lunch with cached session
      const result = await fetchLunchWithSession(sessionCookie, targetDateStr);

      // If authentication failed, we need to login again
      if ("error" in result && result.status === 401) {
        console.debug("Cached session expired, will login again");
        shouldLogin = true;
      } else {
        // Success or other error - return the result
        const formattedResponse = formatLunchResponse(result);
        return new Response(formattedResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
    } else {
      console.debug("No cached session found, will login");
      shouldLogin = true;
    }

    // Login if needed
    if (shouldLogin) {
      const sessionData = await loginAndGetSession(email, password);

      if (!sessionData) {
        return new Response(JSON.stringify({ error: "Failed to login" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      sessionCookie = sessionData.cookie;

      // Store the new session
      await ctx.runMutation(internal.forkable.storeCachedSession, {
        email,
        cookie: sessionCookie,
        expiresAt: sessionData.expiresAt,
      });

      console.debug("Stored new session in cache");
    }

    // Fetch lunch with the session (either cached or newly obtained)
    const result = await fetchLunchWithSession(sessionCookie, targetDateStr);
    const formattedResponse = formatLunchResponse(result);

    return new Response(formattedResponse, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: `Unexpected error: ${error instanceof Error ? error.message : "Unknown error"}`,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});
