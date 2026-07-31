import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';
import { AppIcon } from '../components';
import { useAuthStore } from '../stores';
import { useSyncCartFreeDeliveryProgress } from '../hooks';

import {
  HomeScreen,
  CategoriesScreen,
  OrdersScreen,
  ProfileScreen,
  ProductListScreen,
  ProductDetailScreen,
  CartScreen,
  CheckoutScreen,
  OrderConfirmationScreen,
  OrderDetailScreen,
  RiderTrackingScreen,
  EditProfileScreen,
  AuthScreen,
  NotificationsScreen,
} from '../screens/customer';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const TABS = [
  { name: 'Home',    icon: 'home',    label: 'Home' },
  { name: 'Orders',  icon: 'orders',  label: 'Orders' },
  { name: 'Profile', icon: 'profile', label: 'Profile' },
];

// ─────────────────────────────────────────────────────────────────────────────
// TabItem
// Keeps native-driver and non-native-driver animations strictly separate.
// ─────────────────────────────────────────────────────────────────────────────
function TabItem({ tab, focused, onPress }) {
  // Native-driver only — transform
  const iconScale  = useRef(new Animated.Value(1)).current;
  // Non-native-driver only — width (layout property)
  const dotWidth   = useRef(new Animated.Value(focused ? 16 : 0)).current;

  useEffect(() => {
    // ── Native driver: icon scale bounce ──────────────────────────────────
    Animated.sequence([
      Animated.spring(iconScale, {
        toValue: 0.85,
        friction: 4,
        tension: 250,
        useNativeDriver: true,
      }),
      Animated.spring(iconScale, {
        toValue: 1,
        friction: 5,
        tension: 180,
        useNativeDriver: true,
      }),
    ]).start();

    // ── Non-native driver: dot width ──────────────────────────────────────
    Animated.spring(dotWidth, {
      toValue: focused ? 16 : 0,
      friction: 7,
      tension: 160,
      useNativeDriver: false,
    }).start();
  }, [focused, iconScale, dotWidth]);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={styles.tabItem}
      accessibilityRole="button"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={tab.label}
    >
      {/* Icon */}
      <Animated.View style={{ transform: [{ scale: iconScale }] }}>
        <AppIcon
          name={tab.icon}
          color={focused ? colors.saffron : colors.navInactive}
          size={22}
          strokeWidth={focused ? 2.4 : 1.8}
        />
      </Animated.View>

      {/* Label */}
      <Animated.Text
        style={[
          styles.tabLabel,
          { color: focused ? colors.saffron : colors.navInactive },
        ]}
        numberOfLines={1}
        allowFontScaling={false}
      >
        {tab.label}
      </Animated.Text>

      {/* Saffron dot — expands horizontally when focused */}
      <Animated.View style={[styles.dotIndicator, { width: dotWidth }]} />
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CustomTabBar
// ─────────────────────────────────────────────────────────────────────────────
function CustomTabBar({ state, navigation }) {
  const insets = useSafeAreaInsets();

  // Render-driven hide: when the keyboard opens, unmount the tab bar
  // immediately so it never "flashes" upward. No translate animation
  // (those always have a visible first frame at the wrong position).
  const [keyboardVisible, setKeyboardVisible] = React.useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true)
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardVisible(false)
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  if (keyboardVisible) return null;

  return (
    <View style={styles.tabBarOuter}>
      <View
        style={[
          styles.tabBarCard,
          {
            height: TAB_CONTENT_HEIGHT + insets.bottom,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        {state.routes.map((route, index) => {
          const tab     = TABS[index] || { name: route.name, icon: 'home', label: route.name };
          const focused = state.index === index;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          return (
            <TabItem
              key={route.key}
              tab={tab}
              focused={focused}
              onPress={onPress}
            />
          );
        })}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CustomerBottomTabs
// ─────────────────────────────────────────────────────────────────────────────
function CustomerBottomTabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Home"    component={HomeScreen} />
      <Tab.Screen name="Orders"  component={OrdersScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const TAB_CONTENT_HEIGHT = 62;

const styles = StyleSheet.create({
  bootScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgApp,
  },

  // Outer wrapper — flush to screen bottom
  tabBarOuter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },

  // White card — full width, rounded top corners only
  tabBarCard: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(0,0,0,0.09)',
    paddingHorizontal: 8,
    // Shadow cast upward (iOS only — avoids Android square bug)
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.06,
        shadowRadius: 10,
      },
      android: { elevation: 0 },
    }),
  },

  // Each tab — equal width, items stacked and centered
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 10,
    paddingBottom: 4,
    gap: 2,
  },

  // Label
  tabLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.1,
    includeFontPadding: false,
    lineHeight: 12,
  },

  // Active dot
  dotIndicator: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.saffron,
    overflow: 'hidden',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// CustomerNavigator — root navigator
// ─────────────────────────────────────────────────────────────────────────────
// Location permission is no longer a navigation gate — the dashboard is
// reachable the instant the user is authenticated. Home itself asks for
// location (inline card in its top slot, see useHomeLocationPermission) so
// browsing was never blocked by a separate full-screen route.
function CustomerNavigatorTree({ isAuthenticated }) {
  // StickyMiniCart free-delivery line: keep store progress synced on every
  // cart change (Home / list / categories), not only Cart/Checkout screens.
  useSyncCartFreeDeliveryProgress({ enabled: isAuthenticated });

  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        animation: 'fade_from_bottom',
        animationDuration: 200,
      }}
    >
      {isAuthenticated ? (
        <>
          <Stack.Screen name="MainTabs" component={CustomerBottomTabs} />

          {/* Product Flow */}
          <Stack.Screen name="Categories"    component={CategoriesScreen} />
          <Stack.Screen name="ProductList"   component={ProductListScreen} />
          <Stack.Screen name="ProductDetail" component={ProductDetailScreen} />

          {/* Checkout Flow */}
          <Stack.Screen name="Cart"              component={CartScreen} />
          <Stack.Screen name="Checkout"          component={CheckoutScreen} />
          <Stack.Screen name="OrderConfirmation" component={OrderConfirmationScreen} />

          {/* Account / Misc Flow */}
          <Stack.Screen name="OrderDetail"   component={OrderDetailScreen} />
          <Stack.Screen name="RiderTracking" component={RiderTrackingScreen} />
          <Stack.Screen name="EditProfile"   component={EditProfileScreen} />
          <Stack.Screen name="Notifications" component={NotificationsScreen} />
        </>
      ) : (
        <Stack.Screen name="Auth" component={AuthScreen} />
      )}
    </Stack.Navigator>
  );
}

export default function CustomerNavigator() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);

  // Block only until AsyncStorage has rehydrated the store. Once hydrated,
  // render the cached auth state immediately — session validation (/auth/me)
  // runs in the background. If the server rejects the token (401/403),
  // validateSession() calls logout() which flips isAuthenticated → false and
  // this navigator re-renders to the Auth screen automatically.
  if (!hasHydrated) {
    return (
      <View style={styles.bootScreen}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  }

  return <CustomerNavigatorTree isAuthenticated={isAuthenticated} />;
}
