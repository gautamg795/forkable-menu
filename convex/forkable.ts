import { httpAction } from "./_generated/server";

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

async function getForkableLunch(
  email: string,
  password: string,
): Promise<ForkableResponse | ErrorResponse> {
  const daysAhead = getDaysAhead();
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + daysAhead);
  const targetDateStr = targetDate.toISOString().split("T")[0];

  // Create a cookie jar to maintain session
  let sessionCookie = "";

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
    // Step 1: Login
    const loginResponse = await fetch("https://forkable.com/api/v2/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(loginQuery),
    });

    if (!loginResponse.ok) {
      return { error: `Login failed with status ${loginResponse.status}` };
    }

    const loginData = await loginResponse.json();
    if (loginData?.data?.createSession?.errorAttributes) {
      return { error: "Invalid credentials" };
    }

    // Extract all cookies from login response
    const setCookieHeaders = loginResponse.headers.get("set-cookie");
    if (setCookieHeaders) {
      // Parse cookies properly
      const cookies = setCookieHeaders
        .split(",")
        .map((cookie) => cookie.trim().split(";")[0])
        .join("; ");
      sessionCookie = cookies;
    }

    // Step 2: Get lunch data
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
    };

    if (sessionCookie) {
      lunchHeaders["Cookie"] = sessionCookie;
    }

    const lunchResponse = await fetch("https://forkable.com/api/v2/graphql", {
      method: "POST",
      headers: lunchHeaders,
      body: JSON.stringify(lunchQuery),
    });

    if (!lunchResponse.ok) {
      return {
        error: `Failed to fetch lunch data with status ${lunchResponse.status}`,
      };
    }

    const data = await lunchResponse.json();

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

    return {
      date: targetDateStr,
      lunch: lunchInfo,
      success: true,
    };
  } catch (error) {
    return {
      error: `Network error: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
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
    const result = await getForkableLunch(email, password);
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
