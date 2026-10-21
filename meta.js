// Non-sensitive UI metadata only — plan tier names/limits and benefit limit
// options. The actual premium rates never appear in frontend code.
const META = {
  "JCARE": {
    "tiers": [
      {
        "id": "classic",
        "label": "Classic",
        "limit": 500000
      },
      {
        "id": "premier",
        "label": "Premier",
        "limit": 1000000
      },
      {
        "id": "advanced",
        "label": "Advanced",
        "limit": 2000000
      },
      {
        "id": "executive",
        "label": "Executive",
        "limit": 3000000
      },
      {
        "id": "royal",
        "label": "Royal",
        "limit": 5000000
      },
      {
        "id": "prestige",
        "label": "Prestige",
        "limit": 10000000
      }
    ],
    "covidLimits": [
      500000,
      1000000,
      1500000,
      2000000
    ]
  },
  "JUNIOR": {
    "tiers": [
      {
        "id": "classic",
        "label": "Classic",
        "limit": 500000
      },
      {
        "id": "premier",
        "label": "Premier",
        "limit": 1000000
      },
      {
        "id": "advanced",
        "label": "Advanced",
        "limit": 2000000
      },
      {
        "id": "executive",
        "label": "Executive",
        "limit": 3000000
      },
      {
        "id": "royal",
        "label": "Royal",
        "limit": 5000000
      },
      {
        "id": "prestige",
        "label": "Prestige",
        "limit": 10000000
      }
    ],
    "covidLimits": [
      500000,
      1000000,
      1500000,
      2000000
    ]
  },
  "JSENIOR": {
    "tiers": [
      {
        "id": "basic",
        "label": "Basic",
        "limit": 500000
      },
      {
        "id": "bronze",
        "label": "Bronze",
        "limit": 1000000
      },
      {
        "id": "silver",
        "label": "Silver",
        "limit": 3000000
      },
      {
        "id": "gold",
        "label": "Gold",
        "limit": 5000000
      },
      {
        "id": "diamond",
        "label": "Diamond",
        "limit": 10000000
      }
    ],
    "covidLimits": [
      500000,
      1000000,
      1500000,
      2000000
    ]
  }
};
