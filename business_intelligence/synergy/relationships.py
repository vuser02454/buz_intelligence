"""
What helps what: nearby place types ("anchors") and how they relate to a proposed business.

Every anchor is matched on real OpenStreetMap tags. A relationship says how relevant
an anchor is to a business group (0–1), how many distance-weighted anchors make the
link "fully present" (saturation), whether it is a specific complementary business
or a general demand generator in the surroundings, which customer group it brings,
and the plain-language story and advice shown to the user.
"""

# anchor key -> (singular, plural, customer group, [(tag, values or '*')])
ANCHORS = {
    'office': ('office', 'offices', 'office_workers', [('office', '*'), ('amenity', ('coworking_space',))]),
    'college': ('college or university', 'colleges and universities', 'students', [('amenity', ('college', 'university'))]),
    'school': ('school', 'schools', 'students', [('amenity', ('school', 'kindergarten'))]),
    'hospital': ('hospital or clinic', 'hospitals and clinics', 'patients', [('amenity', ('hospital', 'clinic', 'doctors', 'dentist', 'nursing_home'))]),
    'gym': ('gym or sports centre', 'gyms and sports centres', 'fitness_visitors', [('leisure', ('fitness_centre', 'sports_centre')), ('amenity', ('gym',))]),
    'cinema': ('cinema or theatre', 'cinemas and theatres', 'entertainment_visitors', [('amenity', ('cinema', 'theatre', 'arts_centre'))]),
    'hotel': ('hotel or guest house', 'hotels and guest houses', 'travellers', [('tourism', ('hotel', 'guest_house', 'hostel', 'motel'))]),
    'tourist': ('tourist attraction', 'tourist attractions', 'tourists', [('tourism', ('attraction', 'museum', 'viewpoint', 'zoo', 'theme_park', 'gallery'))]),
    'rail': ('railway or metro station', 'railway and metro stations', 'commuters', [('railway', ('station', 'halt')), ('public_transport', ('station',))]),
    'bus': ('bus stop', 'bus stops', 'commuters', [('highway', ('bus_stop',)), ('amenity', ('bus_station',))]),
    'mall': ('mall, department store or market', 'malls, department stores and markets', 'shoppers', [('shop', ('mall', 'department_store')), ('amenity', ('marketplace',))]),
    'supermarket': ('supermarket', 'supermarkets', 'shoppers', [('shop', ('supermarket',))]),
    'restaurant': ('restaurant or eatery', 'restaurants and eateries', 'diners', [('amenity', ('restaurant', 'fast_food', 'food_court', 'cafe'))]),
    'residential': ('neighbourhood service', 'neighbourhood services', 'residents',
                    [('amenity', ('place_of_worship', 'community_centre')), ('leisure', ('playground', 'park')),
                     ('shop', ('convenience', 'greengrocer', 'dairy'))]),
    'parking_fuel': ('parking or fuel station', 'parking areas and fuel stations', 'motorists', [('amenity', ('parking', 'fuel'))]),
    'car': ('car dealer or garage', 'car dealers and garages', 'motorists', [('shop', ('car', 'car_repair', 'tyres', 'car_parts')), ('amenity', ('car_wash',))]),
    'bank': ('bank or ATM', 'banks and ATMs', 'shoppers', [('amenity', ('bank', 'atm'))]),
}

CUSTOMER_GROUPS = {
    'office_workers': 'office workers', 'students': 'students', 'patients': 'patients and their visitors',
    'fitness_visitors': 'gym and sports visitors', 'entertainment_visitors': 'cinema and theatre visitors',
    'travellers': 'hotel guests and travellers', 'tourists': 'tourists', 'commuters': 'commuters',
    'shoppers': 'shoppers', 'diners': 'people eating out', 'residents': 'local residents', 'motorists': 'vehicle owners',
}

# Anchors that are inferred signals rather than direct evidence (shown with a note).
INFERRED_ANCHORS = {'residential': 'Residential demand is inferred from neighbourhood services (schools, places of '
                                   'worship, parks, corner shops); the map data used here does not include housing.'}


def _rel(anchor, kind, relevance, saturation, how, action):
    return {'anchor': anchor, 'kind': kind, 'relevance': relevance, 'saturation': saturation, 'how': how, 'action': action}


B, E = 'business', 'environment'

RELATIONSHIPS = {
    'cafe': [
        _rel('office', B, 1.0, 8, 'Office workers often look for coffee and snacks before work, at lunch and during short breaks.',
             'Offer quick breakfast combos and takeaway coffee for office workers; keep weekday mornings fast.'),
        _rel('college', B, 0.8, 2, 'Students meet, study and snack between classes and want affordable options.',
             'Add student-priced combos and a quiet seating corner for studying.'),
        _rel('gym', B, 0.5, 2, 'People leaving a gym often want a smoothie, protein snack or healthy drink.',
             'Add healthy drinks and protein snacks timed for morning and evening gym hours.'),
        _rel('cinema', B, 0.5, 1, 'Cinema-goers often grab coffee or dessert before or after a show.',
             'Stay open late on show nights and offer quick dessert-and-coffee options.'),
        _rel('hospital', B, 0.4, 2, 'Patients and visitors waiting at clinics need somewhere to sit and eat.',
             'Offer simple, hygienic food and drinks that can be taken away quickly.'),
        _rel('rail', E, 0.8, 1, 'A station brings a steady stream of commuters who buy on the go.',
             'Make takeaway fast and visible for commuters walking to and from the station.'),
        _rel('bus', E, 0.5, 12, 'Bus stops bring people waiting and passing by on foot.',
             'Keep a visible counter for quick purchases by people passing on foot.'),
        _rel('mall', E, 0.6, 1, 'Shopping destinations draw visitors who take breaks for coffee.',
             'Position the cafe as a resting point for shoppers.'),
        _rel('residential', E, 0.4, 25, 'Nearby homes can provide regular evening and weekend customers.',
             'Build repeat business with loyalty offers for local residents.'),
        _rel('tourist', E, 0.5, 2, 'Tourist spots bring visitors looking for a place to sit and refresh.',
             'Offer local specialities and make the menu easy for visitors.'),
    ],
    'food': [
        _rel('office', B, 0.9, 8, 'Office workers need lunch and quick dinners on working days.',
             'Run a fast weekday lunch menu and offer bulk orders for offices.'),
        _rel('cinema', B, 0.8, 1, 'People often eat before or after watching a film.',
             'Time offers around show times and stay open after late shows.'),
        _rel('college', B, 0.7, 2, 'Students eat out often and look for affordable meals.',
             'Offer value meals and student discounts.'),
        _rel('hotel', B, 0.5, 2, 'Hotel guests look for nearby places to eat.',
             'Partner with nearby hotels to be recommended to their guests.'),
        _rel('mall', B, 0.6, 1, 'Shopping trips often include a meal.',
             'Be easy to find from the shopping area; offer family meal deals at weekends.'),
        _rel('rail', E, 0.7, 1, 'Stations bring large numbers of commuters at fixed times.',
             'Offer quick, packable meals for commuters.'),
        _rel('bus', E, 0.6, 12, 'Bus stops bring people waiting and walking past.',
             'Keep street-facing, quick-service options.'),
        _rel('residential', E, 0.6, 25, 'Nearby homes can order in and visit regularly.',
             'Set up home delivery for nearby neighbourhoods.'),
        _rel('tourist', E, 0.6, 2, 'Tourist attractions bring visitors who need meals.',
             'Highlight local dishes for visitors.'),
    ],
    'health': [
        _rel('hospital', B, 1.0, 3, 'Patients leaving hospitals and clinics usually need medicines right away.',
             'Stock what nearby clinics prescribe most and stay open during clinic hours and evenings.'),
        _rel('residential', E, 0.8, 25, 'Families nearby need regular medicines and health products.',
             'Offer home delivery and refill reminders for regular customers.'),
        _rel('school', E, 0.3, 3, 'Schools mean families with children in the area.',
             'Stock common children\'s health products.'),
        _rel('bus', E, 0.3, 12, 'Bus stops add passing customers.', 'Keep the shop visible from the street.'),
        _rel('rail', E, 0.2, 1, 'A station adds passing commuters.', 'Stay open during commute hours.'),
    ],
    'grocery': [
        _rel('school', B, 0.3, 3, 'Parents doing school runs often pick up daily items.',
             'Open early enough for the school run.'),
        _rel('office', B, 0.3, 8, 'Office workers buy snacks and daily items.',
             'Stock grab-and-go snacks and drinks.'),
        _rel('residential', E, 1.0, 25, 'Homes nearby need daily essentials every day.',
             'Offer phone or app orders with doorstep delivery for nearby homes.'),
        _rel('rail', E, 0.5, 1, 'Commuters pick up essentials on the way home.',
             'Stay open in the evening commute window.'),
        _rel('bus', E, 0.5, 12, 'People waiting for buses make quick purchases.',
             'Keep quick-purchase items near the entrance.'),
    ],
    'fitness': [
        _rel('office', B, 0.8, 8, 'Office workers often exercise before or after work.',
             'Offer early-morning and after-work batches and corporate memberships.'),
        _rel('college', B, 0.7, 2, 'Students are a large, price-sensitive group of gym members.',
             'Offer student memberships and short-term plans.'),
        _rel('residential', E, 0.8, 25, 'Residents nearby can visit regularly without long travel.',
             'Offer family and couple plans for nearby residents.'),
        _rel('rail', E, 0.3, 1, 'A station makes the gym easy to reach.', 'Mention transit access in promotions.'),
        _rel('bus', E, 0.3, 12, 'Bus access widens the catchment.', 'Mention transit access in promotions.'),
    ],
    'personal_care': [
        _rel('office', B, 0.5, 8, 'Office workers use quick services before or after work.',
             'Offer appointment slots before and after office hours.'),
        _rel('hotel', B, 0.5, 2, 'Hotels need regular services and their guests need quick ones.',
             'Approach nearby hotels for service contracts.'),
        _rel('gym', B, 0.4, 2, 'Gym members are often regular users of grooming and laundry services.',
             'Partner with gyms for member discounts.'),
        _rel('college', B, 0.4, 2, 'Students and hostels use affordable services.',
             'Offer student pricing.'),
        _rel('residential', E, 1.0, 25, 'Residents need these services regularly.',
             'Offer pick-up and drop or home-visit services for nearby homes.'),
        _rel('mall', E, 0.4, 1, 'Shopping areas bring people with time to spend.',
             'Stay visible to shoppers.'),
    ],
    'print': [
        _rel('college', B, 1.0, 2, 'Students regularly need printing, photocopies, binding and stationery.',
             'Offer fast printing and binding during exam and assignment season.'),
        _rel('school', B, 0.9, 3, 'Schools create steady demand for stationery and printing.',
             'Stock school supplies before term starts.'),
        _rel('office', B, 0.7, 8, 'Offices need printing, documents and office supplies.',
             'Offer bulk office-supply orders and document services.'),
        _rel('residential', E, 0.3, 25, 'Households need occasional printing and stationery.',
             'Keep basic stationery for families.'),
        _rel('bus', E, 0.3, 12, 'Passing foot traffic adds walk-in customers.', 'Keep the shop easy to spot.'),
    ],
    'education': [
        _rel('school', B, 1.0, 3, 'School students are the main customers for coaching and tuition.',
             'Schedule classes right after school hours.'),
        _rel('college', B, 0.8, 2, 'College students look for exam and skill coaching.',
             'Offer entrance-exam and skill courses.'),
        _rel('residential', E, 0.8, 25, 'Families nearby prefer coaching close to home.',
             'Market directly to nearby neighbourhoods.'),
        _rel('bus', E, 0.4, 12, 'Bus access lets students come from further away.', 'Mention bus routes in promotions.'),
        _rel('rail', E, 0.3, 1, 'A station widens the catchment.', 'Mention station access in promotions.'),
    ],
    'fashion': [
        _rel('mall', B, 0.9, 1, 'Shopping destinations bring people who came to shop.',
             'Locate on the shopper walking route and coordinate sale events.'),
        _rel('cinema', B, 0.4, 1, 'Entertainment visitors browse shops before or after a show.',
             'Stay open in the evening.'),
        _rel('restaurant', B, 0.3, 15, 'Busy dining streets bring browsing visitors.',
             'Use window displays that attract people walking to eat.'),
        _rel('rail', E, 0.6, 1, 'Stations bring many people past the shop.',
             'Use window displays aimed at commuters.'),
        _rel('bus', E, 0.5, 12, 'Bus stops add passing customers.', 'Keep displays visible from the stop.'),
        _rel('tourist', E, 0.5, 2, 'Tourists buy clothing, gifts and souvenirs.', 'Stock gift and local items.'),
        _rel('residential', E, 0.3, 25, 'Residents shop locally for everyday clothing.', 'Stock everyday basics.'),
    ],
    'electronics': [
        _rel('office', B, 0.6, 8, 'Office workers buy phones, accessories and repairs.', 'Offer quick repairs and accessories.'),
        _rel('college', B, 0.6, 2, 'Students buy phones, accessories and need repairs.', 'Offer student deals and repairs.'),
        _rel('mall', B, 0.6, 1, 'Shopping areas bring buyers comparing options.', 'Be competitive on price and service.'),
        _rel('rail', E, 0.5, 1, 'Stations bring passing buyers.', 'Stock fast-selling accessories at the front.'),
        _rel('bus', E, 0.5, 12, 'Bus stops add passing customers.', 'Keep the shop easy to find.'),
        _rel('residential', E, 0.4, 25, 'Households need repairs and accessories.', 'Offer doorstep repair pick-up.'),
    ],
    'travel': [
        _rel('hotel', B, 1.0, 3, 'Hotel guests book tours, cabs and tickets.', 'Partner with hotels to handle their guests\' bookings.'),
        _rel('tourist', B, 0.7, 2, 'Visitors to attractions plan onward trips.', 'Offer local tours and day trips.'),
        _rel('office', B, 0.5, 8, 'Companies book business travel.', 'Offer corporate travel accounts.'),
        _rel('rail', E, 0.7, 1, 'Travellers pass through stations.', 'Be visible from the station.'),
        _rel('bus', E, 0.4, 12, 'Bus routes bring travellers.', 'Offer bus and train ticketing.'),
    ],
    'automotive': [
        _rel('parking_fuel', B, 0.8, 3, 'Fuel stations and parking bring vehicle owners who may need service.',
             'Be easy to reach from fuel stations and main roads.'),
        _rel('car', B, 0.6, 3, 'An automotive cluster attracts vehicle owners looking for parts and service.',
             'Specialise in a service the nearby garages do not offer.'),
        _rel('residential', E, 0.5, 25, 'Residents own vehicles that need regular service.', 'Offer pick-up and drop service.'),
        _rel('office', E, 0.4, 8, 'Commuters drive to offices nearby.', 'Offer service-while-you-work slots.'),
    ],
    'finance': [
        _rel('mall', B, 0.6, 1, 'Shoppers need cash and banking.', 'Locate near the shopping entrance.'),
        _rel('supermarket', B, 0.6, 2, 'Supermarket customers often need cash.', 'Be close to supermarket entrances.'),
        _rel('restaurant', B, 0.5, 15, 'Dining streets bring people who need cash.', 'Stay visible on dining streets.'),
        _rel('hospital', B, 0.4, 2, 'Hospital visitors often need cash for payments.', 'Locate close to hospitals.'),
        _rel('rail', E, 0.7, 1, 'Stations bring large numbers of people.', 'Be visible from the station exit.'),
        _rel('bus', E, 0.5, 12, 'Bus stops bring passers-by.', 'Keep the location well lit and visible.'),
        _rel('residential', E, 0.5, 25, 'Residents need nearby banking.', 'Serve nearby residents\' daily needs.'),
    ],
    'hardware': [
        _rel('car', B, 0.3, 3, 'Workshops and garages buy tools and parts.', 'Offer trade accounts to workshops.'),
        _rel('office', B, 0.2, 8, 'Offices need maintenance supplies.', 'Offer maintenance supply contracts.'),
        _rel('residential', E, 0.9, 25, 'Homes need repair and maintenance supplies.', 'Offer delivery and contractor referrals.'),
        _rel('bus', E, 0.2, 12, 'Passing customers add walk-in sales.', 'Keep a visible frontage.'),
    ],
    'logistics': [
        _rel('supermarket', B, 0.4, 2, 'Retailers need storage and deliveries.', 'Offer storage and delivery contracts to retailers.'),
        _rel('mall', B, 0.4, 1, 'Shopping centres need restocking and storage.', 'Approach mall tenants for storage.'),
        _rel('parking_fuel', B, 0.5, 3, 'Fuel and parking access helps vehicle operations.', 'Plan vehicle access and loading.'),
        _rel('car', B, 0.3, 3, 'An automotive area supports vehicle maintenance.', 'Use nearby workshops for fleet service.'),
        _rel('rail', E, 0.4, 1, 'Rail access helps goods movement.', 'Check freight and access routes.'),
    ],
    'default': [
        _rel('office', B, 0.5, 8, 'Office workers add weekday customers.', 'Offer weekday services for office workers.'),
        _rel('college', B, 0.4, 2, 'Students add regular customers.', 'Offer student pricing.'),
        _rel('mall', B, 0.4, 1, 'Shopping areas bring visitors.', 'Be visible to shoppers.'),
        _rel('residential', E, 0.6, 25, 'Residents nearby can become regular customers.', 'Build loyalty with local residents.'),
        _rel('bus', E, 0.5, 12, 'Bus stops bring passing customers.', 'Keep a visible frontage.'),
        _rel('rail', E, 0.5, 1, 'A station brings many people nearby.', 'Be visible from the station.'),
    ],
}

# Business keys (recommendation categories, engine keys, OSM values) -> relationship group.
_GROUP_KEYS = {
    'cafe': ('cafe', 'coffee_shop', 'juice_bar', 'bakery', 'ice_cream_parlour', 'ice_cream', 'tea', 'sweet_shop'),
    'food': ('restaurant', 'fast_food', 'food_court', 'street_food_stall', 'tiffin_service'),
    'health': ('pharmacy', 'medical_store', 'chemist', 'optical_store', 'optician'),
    'grocery': ('grocery_store', 'supermarket', 'vegetable_shop', 'fruit_shop', 'milk_booth', 'convenience', 'greengrocer', 'dairy'),
    'fitness': ('gym', 'fitness_centre', 'sports_centre', 'fitness_center'),
    'personal_care': ('salon', 'laundry_service', 'tailoring_shop', 'spa', 'beauty', 'hairdresser', 'laundry'),
    'print': ('stationery_shop', 'printing_shop', 'photocopy_shop', 'book_store', 'internet_cafe', 'stationery'),
    'education': ('coaching_centre', 'tuition_centre'),
    'fashion': ('clothing_store', 'clothing_boutique', 'footwear_store', 'jewellery_store', 'cosmetics_store', 'clothes', 'shoes', 'flower_shop'),
    'electronics': ('mobile_shop', 'electronics_store', 'electronics', 'mobile_phone'),
    'travel': ('travel_agency',),
    'automotive': ('auto_repair_shop', 'spare_parts_shop', 'cycle_repair', 'fuel_station', 'car_repair'),
    'finance': ('atm', 'bank'),
    'hardware': ('hardware_store', 'plumbing_supply'),
    'logistics': ('warehouse', 'storage_facility', 'cold_storage', 'logistics_hub', 'courier_service', 'wholesale_store'),
}
GROUP_OF = {key: group for group, keys in _GROUP_KEYS.items() for key in keys}

# Groups where a cluster of similar places can turn the street into a destination
# (people come to compare) – weight of that positive cluster effect.
DESTINATION_WEIGHT = {'food': 0.6, 'fashion': 0.8, 'electronics': 0.8, 'automotive': 0.5, 'cafe': 0.3, 'hardware': 0.4}


def business_key(name):
    return str(name or '').strip().lower().replace('-', ' ').replace(' ', '_')


def group_for(business):
    return GROUP_OF.get(business_key(business), 'default')


def anchor_of(tags):
    """Anchor keys an element's tags match (an element can match several, e.g. a cafe is also a 'restaurant')."""
    found = []
    for key, (_s, _p, _c, rules) in ANCHORS.items():
        for tag, values in rules:
            value = tags.get(tag)
            if value and (values == '*' or value in values):
                found.append(key)
                break
    return found
