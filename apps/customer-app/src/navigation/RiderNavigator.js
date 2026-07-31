import React from 'react';
import { View, StyleSheet } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, shadows, radius } from '../theme';
import AppIcon from '../components/AppIcon';
import { useRiderLocationPermission } from '../hooks/useRiderLocationPermission';
import {
  RiderDashboardScreen,
  RiderHistoryScreen,
  RiderOrderScreen,
} from '../screens/rider';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function TabIcon({ name, focused, size, color }) {
  return (
    <View style={styles.iconWrap}>
      <View style={[styles.iconBubble, focused && styles.iconBubbleActive]}>
        <AppIcon name={name} color={focused ? colors.saffronDark : color} size={size - 1} />
      </View>
      {focused ? <View style={styles.activeDot} /> : <View style={styles.activeDotSpacer} />}
    </View>
  );
}

function RiderTabs() {
  const insets = useSafeAreaInsets();

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.saffronDark,
        tabBarInactiveTintColor: colors.navInactive,
        tabBarLabelStyle: { fontWeight: '700', fontSize: 11, marginTop: 2 },
        tabBarStyle: {
          backgroundColor: colors.navBg,
          borderTopWidth: 0,
          height: 68 + insets.bottom,
          paddingBottom: 10 + insets.bottom,
          paddingTop: 8,
          ...shadows.navBar,
        },
        sceneContainerStyle: { backgroundColor: colors.bgApp },
      }}
    >
      <Tab.Screen
        name="RiderDashboard"
        component={RiderDashboardScreen}
        options={{
          title: 'Ride',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="navigation" color={color} size={size} focused={focused} />
          ),
        }}
      />
      <Tab.Screen
        name="RiderHistory"
        component={RiderHistoryScreen}
        options={{
          title: 'History',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="orders" color={color} size={size} focused={focused} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

/**
 * RiderNavigator — delivery partner shell + full-screen order map.
 */
export default function RiderNavigator() {
  useRiderLocationPermission();

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="RiderTabs" component={RiderTabs} />
      <Stack.Screen
        name="RiderOrder"
        component={RiderOrderScreen}
        options={{ animation: 'slide_from_right' }}
      />
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 30,
  },
  iconBubble: {
    width: 36,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBubbleActive: {
    backgroundColor: colors.saffronLight,
  },
  activeDot: {
    width: 4,
    height: 4,
    borderRadius: radius.circle,
    backgroundColor: colors.saffron,
    marginTop: 2,
  },
  activeDotSpacer: {
    width: 4,
    height: 4,
    marginTop: 2,
  },
});